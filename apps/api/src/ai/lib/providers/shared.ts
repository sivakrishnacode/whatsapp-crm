import { AiError, type ChatMessage, type ToolCall, type ToolDefinition } from '../types';

export interface ProviderArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  timeoutMs: number;
  /** Omitted or empty = plain completion, no tool machinery at all. */
  tools?: ToolDefinition[];
}

/**
 * One provider turn. Either the model produced text, or it asked to run
 * tools — both can be present, and both must survive the round-trip or
 * the follow-up call loses the model's own reasoning.
 */
export interface ProviderTurn {
  text: string;
  toolCalls: ToolCall[];
}

export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  });
}

export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = '';
  try {
    const body = (await res.json()) as {
      error?: { message?: string } | string;
    };
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '');
  } catch {
    // Non-JSON error body
  }

  const { status } = res;
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error';
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'rate_limited'
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`;

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    status: code === 'invalid_key' ? 401 : 502,
  });
}

/**
 * Collapse consecutive same-role turns, which Anthropic rejects and the
 * others merely handle badly.
 *
 * Tool turns are never merged: each one answers a specific tool call id,
 * and losing that pairing breaks the follow-up request. Assistant turns
 * carrying tool calls are likewise left alone.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    const mergeable =
      last &&
      last.role === m.role &&
      m.role !== 'tool' &&
      !last.toolCalls?.length &&
      !m.toolCalls?.length;
    if (mergeable) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

/** Parse a provider's tool arguments (JSON string or object) without trusting it. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A model that emits malformed JSON gets an empty argument object,
    // and the tool's own required-argument check then rejects the call —
    // strictly better than throwing away the whole reply.
    return {};
  }
}
