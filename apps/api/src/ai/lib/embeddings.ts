import { AiError } from './types';
import { aiRequestTimeoutMs } from './defaults';
import { providerHttpError, toNetworkError } from './providers/shared';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

const BATCH_SIZE = 96;

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export async function embedTexts(
  apiKey: string,
  inputs: string[],
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const timeoutMs = aiRequestTimeoutMs();
  const out: number[][] = [];

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE);

    let res: Response;
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err);
    }

    if (!res.ok) {
      throw await providerHttpError('OpenAI embeddings', res);
    }

    const data = (await res.json().catch(() => null)) as EmbeddingResponse | null;
    const rows = data?.data;
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Embeddings response was malformed.', {
        code: 'embeddings_malformed',
      });
    }

    if (rows.some((r) => typeof r.index !== 'number')) {
      throw new AiError('Embeddings response was missing result indices.', {
        code: 'embeddings_malformed',
      });
    }
    const ordered = [...rows].sort((a, b) => a.index! - b.index!);
    for (const r of ordered) {
      if (!Array.isArray(r.embedding)) {
        throw new AiError('Embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        });
      }
      out.push(r.embedding);
    }
  }

  return out;
}
