import { AiError, type ChatMessage } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  asTokenCount,
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
  type ProviderTurn,
} from './shared';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic is the strictest of the three: the first turn must be
 * `user`, roles must alternate, and a tool result is a *user* turn
 * carrying a `tool_result` block rather than its own role.
 */
function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const merged = mergeConsecutive(messages);
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

  for (const m of merged) {
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      const last = out[out.length - 1];
      // Consecutive tool results belong in ONE user turn — two adjacent
      // user turns is exactly what this API rejects.
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: unknown[] = [];
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push({ role: m.role, content: m.content });
  }

  while (out.length > 0 && out[0].role === 'assistant') {
    out.shift();
  }
  if (out.length === 0) {
    return [
      { role: 'user', content: '(The customer has not sent a message yet.)' },
    ];
  }
  return out;
}

export async function generateAnthropic(
  args: ProviderArgs,
): Promise<ProviderTurn> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args;

  const body: Record<string, unknown> = {
    model,
    system: systemPrompt,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: toAnthropicMessages(messages),
  };

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res);
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null;
  const blocks = data?.content ?? [];

  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();

  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use' && b.name)
    .map((b, i) => ({
      id: b.id ?? `call_${i}`,
      name: b.name!,
      arguments:
        b.input && typeof b.input === 'object'
          ? b.input
          : ({} as Record<string, unknown>),
    }));

  if (!text && toolCalls.length === 0) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    });
  }

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: asTokenCount(data?.usage?.input_tokens),
      outputTokens: asTokenCount(data?.usage?.output_tokens),
    },
  };
}
