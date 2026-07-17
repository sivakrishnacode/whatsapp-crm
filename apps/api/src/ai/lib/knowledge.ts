import { PrismaService } from '../../prisma/prisma.service';
import type { AiConfig } from './types';
import { chunkText } from './chunk';
import { embedTexts, toVectorLiteral } from './embeddings';

interface MatchRow {
  id: string;
  content: string;
}

export async function ingestDocument(
  prisma: PrismaService,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content);

  // 1. Delete existing chunks (idempotent)
  await prisma.$executeRawUnsafe(
    'DELETE FROM ai_knowledge_chunks WHERE document_id = $1::uuid',
    documentId,
  );

  if (chunks.length === 0) return;

  // 2. Generate embeddings if key is set
  let embeddings: number[][] | null = null;
  let embedError: unknown = null;
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks);
    } catch (err) {
      embedError = err;
    }
  }

  // 3. Insert chunks using raw SQL to handle pgvector Unsupported cast
  for (let i = 0; i < chunks.length; i++) {
    const chunkContent = chunks[i];
    const vectorStr = embeddings ? toVectorLiteral(embeddings[i]) : null;

    if (vectorStr) {
      await prisma.$executeRawUnsafe(
        'INSERT INTO ai_knowledge_chunks (document_id, account_id, chunk_index, content, embedding) VALUES ($1::uuid, $2::uuid, $3::integer, $4, $5::vector)',
        documentId,
        accountId,
        i,
        chunkContent,
        vectorStr,
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

  if (embedError) throw embedError;
}

export async function retrieveKnowledge(
  prisma: PrismaService,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim();
  if (!query || k <= 0) return [];

  // Check if count > 0 in chunks
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      'SELECT COUNT(*)::integer as count FROM ai_knowledge_chunks WHERE account_id = $1::uuid',
      accountId,
    );
    const count = Number(rows?.[0]?.count ?? 0);
    if (count === 0) return [];
  } catch {
    return [];
  }

  const picked = new Map<string, string>(); // id -> content

  // 1. Semantic path
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query]);
      if (queryEmbedding) {
        const rows = await prisma.$queryRawUnsafe<MatchRow[]>(
          'SELECT id, content FROM match_ai_knowledge_semantic($1::uuid, $2, $3::integer)',
          accountId,
          toVectorLiteral(queryEmbedding),
          k,
        );
        if (Array.isArray(rows)) {
          for (const row of rows) {
            picked.set(row.id, row.content);
          }
        }
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err);
    }
  }

  // 2. Lexical top-up (or sole path if no embedding key)
  if (picked.size < k) {
    try {
      const rows = await prisma.$queryRawUnsafe<MatchRow[]>(
        'SELECT id, content FROM match_ai_knowledge_fts($1::uuid, $2, $3::integer)',
        accountId,
        query,
        k,
      );
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (picked.size >= k) break;
          if (!picked.has(row.id)) {
            picked.set(row.id, row.content);
          }
        }
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err);
    }
  }

  return Array.from(picked.values()).slice(0, k);
}
