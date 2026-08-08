import { PrismaService } from '../../prisma/prisma.service';
import type { AiConfig, EmbeddingsProvider, KnowledgeHit } from './types';
import { chunkText } from './chunk';
import { EMBEDDING_MODEL, embedTexts, toVectorLiteral } from './embeddings';
import { estimateEmbeddingTokens } from '../credits/credits.constants';

interface MatchRow {
  id: string;
  document_id: string;
  content: string;
}

/** What `ingestDocument` needs: a key, and which model it belongs to. */
export interface EmbeddingsContext {
  embeddingsApiKey: string | null;
  embeddingsProvider?: EmbeddingsProvider | null;
  embeddingsModel?: string | null;
}

export interface IngestResult {
  chunks: number;
  embedded: boolean;
  /** Set when chunking succeeded but embedding did not. */
  embedError: unknown;
  /** The model recorded against the new chunks, or null if unembedded. */
  model: string | null;
  /**
   * Roughly how many tokens were embedded, for metering when the run
   * used OUR key. Reported rather than charged here so this stays a
   * pure lib function — the service that knows whose key it was does
   * the charging.
   */
  embeddedTokens: number;
}

function resolveModel(config: EmbeddingsContext): string {
  const provider: EmbeddingsProvider = config.embeddingsProvider ?? 'openai';
  return config.embeddingsModel?.trim() || EMBEDDING_MODEL[provider];
}

/**
 * Chunk a document and (if a key is configured) embed the chunks.
 *
 * Chunks are always written even when embedding fails, so the document
 * stays findable by full-text search — a document that is silently
 * invisible to the agent is the worst outcome here, worse than one that
 * is only keyword-searchable. The embedding error is RETURNED rather
 * than swallowed so the caller can set the document's status and tell
 * the user what to fix.
 */
export async function ingestDocument(
  prisma: PrismaService,
  accountId: string,
  config: EmbeddingsContext,
  documentId: string,
  content: string,
): Promise<IngestResult> {
  const chunks = chunkText(content);
  const model = resolveModel(config);

  // 1. Delete existing chunks (idempotent — this is also the reindex path).
  await prisma.$executeRawUnsafe(
    'DELETE FROM ai_knowledge_chunks WHERE document_id = $1::uuid',
    documentId,
  );

  if (chunks.length === 0) {
    return {
      chunks: 0,
      embedded: false,
      embedError: null,
      model: null,
      embeddedTokens: 0,
    };
  }

  // 2. Embed, if a key is configured.
  let embeddings: number[][] | null = null;
  let embedError: unknown = null;
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks, {
        provider: config.embeddingsProvider ?? 'openai',
        model,
      });
    } catch (err) {
      embedError = err;
    }
  }

  // 3. Insert. Raw SQL because `embedding` is a pgvector column Prisma
  //    models as Unsupported and cannot write through the client.
  for (let i = 0; i < chunks.length; i++) {
    const chunkContent = chunks[i];
    const vectorStr = embeddings ? toVectorLiteral(embeddings[i]) : null;

    if (vectorStr) {
      await prisma.$executeRawUnsafe(
        'INSERT INTO ai_knowledge_chunks (document_id, account_id, chunk_index, content, embedding, embedding_model) VALUES ($1::uuid, $2::uuid, $3::integer, $4, $5::vector, $6)',
        documentId,
        accountId,
        i,
        chunkContent,
        vectorStr,
        model,
      );
    } else {
      await prisma.$executeRawUnsafe(
        'INSERT INTO ai_knowledge_chunks (document_id, account_id, chunk_index, content) VALUES ($1::uuid, $2::uuid, $3::integer, $4)',
        documentId,
        accountId,
        i,
        chunkContent,
      );
    }
  }

  return {
    chunks: chunks.length,
    embedded: Boolean(embeddings),
    embedError,
    model: embeddings ? model : null,
    // Only what was actually embedded. A failed embed call is not
    // billable — the document sits in keyword-search-only mode and the
    // user is already being asked to fix something.
    embeddedTokens: embeddings ? estimateEmbeddingTokens(chunks) : 0,
  };
}

/**
 * Hybrid retrieval: semantic first (when a key is set), then a lexical
 * top-up to fill the remaining slots. Returns hits carrying their
 * document id and title so a reply can say what grounded it.
 *
 * The semantic query is filtered to the account's CURRENT embedding
 * model. Vectors from a different model are geometrically unrelated, so
 * mixing them would return confident nonsense; filtering means switching
 * provider degrades to keyword search until a reindex, which is the
 * honest failure.
 */
export async function retrieveKnowledge(
  prisma: PrismaService,
  accountId: string,
  config: Pick<
    AiConfig,
    'embeddingsApiKey' | 'embeddingsProvider' | 'embeddingsModel'
  >,
  queryText: string,
  k = 5,
): Promise<KnowledgeHit[]> {
  const query = queryText.trim();
  if (!query || k <= 0) return [];

  try {
    const rows = await prisma.$queryRawUnsafe<{ count: number }[]>(
      'SELECT COUNT(*)::integer as count FROM ai_knowledge_chunks WHERE account_id = $1::uuid',
      accountId,
    );
    const count = Number(rows?.[0]?.count ?? 0);
    if (count === 0) return [];
  } catch {
    return [];
  }

  const picked = new Map<string, KnowledgeHit>();

  // 1. Semantic path.
  if (config.embeddingsApiKey) {
    try {
      const model = resolveModel({
        embeddingsApiKey: config.embeddingsApiKey,
        embeddingsProvider: config.embeddingsProvider,
        embeddingsModel: config.embeddingsModel,
      });
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query], {
        provider: config.embeddingsProvider ?? 'openai',
        model,
      });
      if (queryEmbedding) {
        const rows = await prisma.$queryRawUnsafe<MatchRow[]>(
          'SELECT id, document_id, content FROM match_ai_knowledge_semantic($1::uuid, $2, $3::integer, $4)',
          accountId,
          toVectorLiteral(queryEmbedding),
          k,
          model,
        );
        if (Array.isArray(rows)) {
          for (const row of rows) {
            picked.set(row.id, {
              chunkId: row.id,
              documentId: row.document_id,
              content: row.content,
            });
          }
        }
      }
    } catch (err) {
      console.error(
        '[ai knowledge] semantic retrieval failed, falling back to FTS:',
        err,
      );
    }
  }

  // 2. Lexical top-up (or sole path without an embeddings key).
  if (picked.size < k) {
    try {
      const rows = await prisma.$queryRawUnsafe<MatchRow[]>(
        'SELECT id, document_id, content FROM match_ai_knowledge_fts($1::uuid, $2, $3::integer)',
        accountId,
        query,
        k,
      );
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (picked.size >= k) break;
          if (!picked.has(row.id)) {
            picked.set(row.id, {
              chunkId: row.id,
              documentId: row.document_id,
              content: row.content,
            });
          }
        }
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err);
    }
  }

  const hits = Array.from(picked.values()).slice(0, k);
  if (hits.length === 0) return [];

  // Titles in one query — the prompt cites documents by name, and the
  // test panel shows the user which ones answered.
  try {
    const docs = await prisma.ai_knowledge_documents.findMany({
      where: {
        account_id: accountId,
        id: { in: Array.from(new Set(hits.map((h) => h.documentId))) },
      },
      select: { id: true, title: true },
    });
    const titles = new Map(docs.map((d) => [d.id, d.title]));
    for (const hit of hits) {
      const title = titles.get(hit.documentId);
      if (title) hit.title = title;
    }
  } catch {
    // Titles are a nicety; a failure here must not lose the excerpts.
  }

  return hits;
}
