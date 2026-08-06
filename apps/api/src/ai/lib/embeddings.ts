import { AiError, type EmbeddingsProvider } from './types';
import { aiRequestTimeoutMs } from './defaults';
import { providerHttpError, toNetworkError } from './providers/shared';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * ============================================================
 * Knowledge-base embeddings.
 *
 * `ai_knowledge_chunks.embedding` is `vector(1536)` (migration 030) and
 * the HNSW index is built on that width, so EVERY provider here must
 * produce exactly 1536 dimensions. OpenAI's text-embedding-3-small is
 * natively 1536; Gemini's gemini-embedding-001 is natively 3072 and is
 * asked for 1536 via `outputDimensionality`, which is a Matryoshka
 * truncation — Google's own guidance is to re-normalise after
 * truncating, which `normalize()` below does.
 *
 * Vectors from two different models are NOT comparable. Each chunk
 * therefore records which model wrote it (migration 069) and retrieval
 * filters on the account's current model, so switching provider returns
 * *no* semantic hits (and a reindex prompt) rather than nonsense
 * neighbours.
 * ============================================================
 */

export const EMBEDDING_DIMENSIONS = 1536;

export const EMBEDDING_MODEL: Record<EmbeddingsProvider, string> = {
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
};

/** Kept as a named export: pre-069 callers imported this constant. */
export const DEFAULT_EMBEDDING_MODEL = EMBEDDING_MODEL.openai;

const BATCH_SIZE: Record<EmbeddingsProvider, number> = {
  openai: 96,
  // Gemini's batchEmbedContents is documented for up to 100 requests but
  // rejects large batches of long chunks on the free tier; 32 keeps a
  // 1200-char chunk batch comfortably inside the request cap.
  gemini: 32,
};

interface OpenAiEmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
}

interface GeminiEmbeddingResponse {
  embeddings?: { values?: number[] }[];
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** Re-normalise to unit length — required after Matryoshka truncation. */
function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const magnitude = Math.sqrt(sum);
  if (!magnitude || !Number.isFinite(magnitude)) return vector;
  return vector.map((v) => v / magnitude);
}

function assertWidth(vector: number[], provider: string): number[] {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new AiError(
      `${provider} returned a ${vector.length}-dimension vector; the knowledge base stores ${EMBEDDING_DIMENSIONS}. Pick a different embeddings model.`,
      { code: 'embeddings_dimension_mismatch' },
    );
  }
  return vector;
}

async function embedOpenAi(
  apiKey: string,
  inputs: string[],
  model: string,
  timeoutMs: number,
): Promise<number[][]> {
  const out: number[][] = [];

  for (let start = 0; start < inputs.length; start += BATCH_SIZE.openai) {
    const batch = inputs.slice(start, start + BATCH_SIZE.openai);

    let res: Response;
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err);
    }

    if (!res.ok) {
      throw await providerHttpError('OpenAI embeddings', res);
    }

    const data = (await res
      .json()
      .catch(() => null)) as OpenAiEmbeddingResponse | null;
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
      out.push(assertWidth(r.embedding, 'OpenAI'));
    }
  }

  return out;
}

async function embedGemini(
  apiKey: string,
  inputs: string[],
  model: string,
  timeoutMs: number,
): Promise<number[][]> {
  const modelPath = model.startsWith('models/') ? model : `models/${model}`;
  const out: number[][] = [];

  for (let start = 0; start < inputs.length; start += BATCH_SIZE.gemini) {
    const batch = inputs.slice(start, start + BATCH_SIZE.gemini);

    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE}/${modelPath}:batchEmbedContents`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: modelPath,
            content: { parts: [{ text }] },
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err);
    }

    if (!res.ok) {
      throw await providerHttpError('Gemini embeddings', res);
    }

    const data = (await res
      .json()
      .catch(() => null)) as GeminiEmbeddingResponse | null;
    const rows = data?.embeddings;
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Embeddings response was malformed.', {
        code: 'embeddings_malformed',
      });
    }
    // batchEmbedContents returns results positionally — there is no index
    // to sort by, so order is the only correlation we get.
    for (const row of rows) {
      if (!Array.isArray(row.values)) {
        throw new AiError('Embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        });
      }
      out.push(normalize(assertWidth(row.values, 'Gemini')));
    }
  }

  return out;
}

export interface EmbedOptions {
  provider?: EmbeddingsProvider | null;
  model?: string | null;
}

/**
 * Embed a list of texts. `provider` defaults to OpenAI so every pre-069
 * caller (which passed only a key) keeps its exact behaviour.
 */
export async function embedTexts(
  apiKey: string,
  inputs: string[],
  opts: EmbedOptions = {},
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const provider: EmbeddingsProvider = opts.provider ?? 'openai';
  const model = opts.model?.trim() || EMBEDDING_MODEL[provider];
  const timeoutMs = aiRequestTimeoutMs();

  return provider === 'gemini'
    ? embedGemini(apiKey, inputs, model, timeoutMs)
    : embedOpenAi(apiKey, inputs, model, timeoutMs);
}
