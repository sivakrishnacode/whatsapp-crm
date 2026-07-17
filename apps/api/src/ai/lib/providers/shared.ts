import { AiError, type ChatMessage } from '../types';

export interface ProviderArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  timeoutMs: number;
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
        : body?.error?.message ?? '';
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

export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}
