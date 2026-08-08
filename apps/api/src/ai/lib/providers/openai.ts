import { AiError, type ChatMessage } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  asTokenCount,
  mergeConsecutive,
  parseToolArguments,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
  type ProviderTurn,
} from './shared';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiResponse {
  choices?: {
    message?: { content?: string; tool_calls?: OpenAiToolCall[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Map our neutral turns onto the chat-completions message shape. */
function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  return mergeConsecutive(messages).map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        // `content` may be empty on a pure tool-call turn; the API wants
        // the key present regardless.
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export async function generateOpenAi(
  args: ProviderArgs,
): Promise<ProviderTurn> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...toOpenAiMessages(messages),
    ],
    max_completion_tokens: MAX_OUTPUT_TOKENS,
  };

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body.tool_choice = 'auto';
  }

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res);
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
  const message = data?.choices?.[0]?.message;
  const text = typeof message?.content === 'string' ? message.content : '';
  const toolCalls = (message?.tool_calls ?? [])
    .filter((c) => c.function?.name)
    .map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function!.name!,
      arguments: parseToolArguments(c.function?.arguments),
    }));

  if (!text.trim() && toolCalls.length === 0) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    });
  }

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: asTokenCount(data?.usage?.prompt_tokens),
      outputTokens: asTokenCount(data?.usage?.completion_tokens),
    },
  };
}
