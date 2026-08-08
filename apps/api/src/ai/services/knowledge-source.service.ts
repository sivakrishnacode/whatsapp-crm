import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { loadEmbeddingsKey } from '../lib/config';
import { crawlPage } from '../lib/crawl';
import { EMBEDDING_MODEL } from '../lib/embeddings';
import { extractFileText, MAX_UPLOAD_BYTES } from '../lib/extract';
import { ingestDocument } from '../lib/knowledge';
import { AiError } from '../lib/types';
import { AiCreditsService } from '../credits/ai-credits.service';

export type KnowledgeStatus = 'ready' | 'indexing' | 'lexical' | 'failed' | 'stale';

interface IngestOutcome {
  status: KnowledgeStatus;
  chunk_count: number;
  warning: string | null;
}

/**
 * ============================================================
 * Knowledge sources: pasted text, a crawled page, an uploaded file.
 *
 * All three land in the same `ai_knowledge_documents` row and the same
 * chunk table — one corpus, retrieved identically. `source_type` exists
 * so the UI can say where a document came from and offer "re-crawl",
 * not because the agent treats them differently.
 *
 * THE STATUS COLUMN IS THE POINT OF THIS SERVICE. Before it, a document
 * whose embedding call failed looked saved and was invisible to semantic
 * retrieval, which surfaces to the user as "the AI ignores my documents"
 * with nothing to diagnose. Every path here ends by writing an honest
 * status: `ready` (embedded), `lexical` (keyword-only), `failed`, or
 * `stale` (embedded with a model the account no longer uses).
 * ============================================================
 */
@Injectable()
export class KnowledgeSourceService {
  private readonly logger = new Logger(KnowledgeSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: AiCreditsService,
  ) {}

  async list(accountId: string) {
    const documents = await this.prisma.ai_knowledge_documents.findMany({
      where: { account_id: accountId },
      select: {
        id: true,
        title: true,
        source_type: true,
        source_url: true,
        file_name: true,
        byte_size: true,
        status: true,
        error: true,
        chunk_count: true,
        indexed_at: true,
        updated_at: true,
      },
      orderBy: { updated_at: 'desc' },
    });

    const { key, provider, model } = await loadEmbeddingsKey(
      this.prisma,
      accountId,
    );

    return {
      documents,
      semantic: {
        enabled: Boolean(key),
        provider: key ? provider : null,
        model: key ? (model ?? EMBEDDING_MODEL[provider]) : null,
      },
      limits: {
        max_upload_bytes: MAX_UPLOAD_BYTES,
      },
    };
  }

  /**
   * Index (or reindex) one document's content and record the outcome.
   * Never throws for an embedding failure — the chunks are already
   * written and keyword search works, so the honest answer is a
   * `lexical` status plus a warning, not a 500 on a successful save.
   */
  private async index(args: {
    accountId: string;
    documentId: string;
    content: string;
  }): Promise<IngestOutcome> {
    const { accountId, documentId, content } = args;
    const { key, corrupt, provider, model, source } = await loadEmbeddingsKey(
      this.prisma,
      accountId,
    );

    let status: KnowledgeStatus = 'ready';
    let warning: string | null = null;
    let chunkCount = 0;

    try {
      const result = await ingestDocument(
        this.prisma,
        accountId,
        {
          embeddingsApiKey: key,
          embeddingsProvider: provider,
          embeddingsModel: model,
        },
        documentId,
        content,
      );
      chunkCount = result.chunks;

      // Indexing on OUR key is billable, at roughly a hundredth of what
      // the same tokens would cost through a chat model. Charged after
      // the fact and never fatal — the document is already indexed, and
      // failing the upload over a metering error would be absurd.
      if (source === 'platform' && result.embeddedTokens > 0) {
        await this.credits.chargeEmbedding({
          accountId,
          provider: 'gemini',
          model: result.model ?? 'unknown',
          tokens: result.embeddedTokens,
        });
      }

      if (result.chunks === 0) {
        status = 'failed';
        warning = 'Nothing indexable was found in that content.';
      } else if (result.embedError) {
        status = 'lexical';
        const message =
          result.embedError instanceof AiError
            ? result.embedError.message
            : 'the embeddings call failed';
        warning = `Saved and keyword-searchable, but semantic indexing failed (${message}). Fix the embeddings key and use Reindex.`;
      } else if (!result.embedded) {
        status = 'lexical';
        warning = corrupt
          ? 'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter it).'
          : null;
      }
    } catch (err) {
      this.logger.error(`[knowledge] indexing ${documentId} failed: ${err}`);
      status = 'failed';
      warning =
        err instanceof AiError
          ? err.message
          : 'Indexing failed. Use Reindex to try again.';
    }

    await this.prisma.ai_knowledge_documents.update({
      where: { id: documentId },
      data: {
        status,
        error: warning,
        chunk_count: chunkCount,
        indexed_at: status === 'failed' ? null : new Date(),
      },
    });

    return { status, chunk_count: chunkCount, warning };
  }

  /** Pasted text, or an edit to any document's content. */
  async createFromText(args: {
    accountId: string;
    userId: string;
    title: string;
    content: string;
  }) {
    const doc = await this.prisma.ai_knowledge_documents.create({
      data: {
        account_id: args.accountId,
        created_by: args.userId,
        title: args.title,
        content: args.content,
        source_type: 'text',
        status: 'indexing',
      },
      select: { id: true },
    });

    const outcome = await this.index({
      accountId: args.accountId,
      documentId: doc.id,
      content: args.content,
    });

    return { success: true, id: doc.id, ...outcome };
  }

  /** Crawl one page into a document. Re-crawling an existing id updates it. */
  async createFromUrl(args: {
    accountId: string;
    userId: string;
    url: string;
    documentId?: string;
  }) {
    let page;
    try {
      page = await crawlPage(args.url);
    } catch (err) {
      if (err instanceof AiError) {
        throw new HttpException(
          { error: err.message, code: err.code },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException(
        { error: 'Could not read that page.', code: 'crawl_failed' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const data = {
      title: page.title || page.url,
      content: page.text,
      source_type: 'url',
      source_url: page.url,
      byte_size: Buffer.byteLength(page.text, 'utf8'),
      status: 'indexing' as const,
    };

    let documentId: string;
    if (args.documentId) {
      const existing = await this.prisma.ai_knowledge_documents.findFirst({
        where: { id: args.documentId, account_id: args.accountId },
        select: { id: true },
      });
      if (!existing) {
        throw new HttpException('Not found', HttpStatus.NOT_FOUND);
      }
      await this.prisma.ai_knowledge_documents.update({
        where: { id: existing.id },
        data,
      });
      documentId = existing.id;
    } else {
      const created = await this.prisma.ai_knowledge_documents.create({
        data: {
          ...data,
          account_id: args.accountId,
          created_by: args.userId,
        },
        select: { id: true },
      });
      documentId = created.id;
    }

    const outcome = await this.index({
      accountId: args.accountId,
      documentId,
      content: page.text,
    });

    return {
      success: true,
      id: documentId,
      title: data.title,
      url: page.url,
      truncated: page.truncated,
      ...outcome,
    };
  }

  /**
   * An uploaded file. Base64 in a JSON body, matching the ads media
   * endpoint — this API has no multipart parser, and adding one for a
   * single endpoint would be the larger change.
   */
  async createFromFile(args: {
    accountId: string;
    userId: string;
    fileName: string;
    dataBase64: string;
    title?: string;
  }) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(args.dataBase64, 'base64');
    } catch {
      throw new HttpException(
        { error: 'That upload was not valid base64.', code: 'upload_invalid' },
        HttpStatus.BAD_REQUEST,
      );
    }
    // Buffer.from does not throw on malformed base64 — it silently drops
    // the bad characters, so an empty result is the only signal.
    if (bytes.byteLength === 0) {
      throw new HttpException(
        { error: 'That upload was empty or not valid base64.', code: 'upload_invalid' },
        HttpStatus.BAD_REQUEST,
      );
    }

    let extracted;
    try {
      extracted = await extractFileText({ fileName: args.fileName, bytes });
    } catch (err) {
      if (err instanceof AiError) {
        throw new HttpException(
          { error: err.message, code: err.code },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException(
        { error: 'Could not read that file.', code: 'upload_unreadable' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const title =
      args.title?.trim().slice(0, 200) ||
      args.fileName.replace(/\.[a-z0-9]+$/i, '').slice(0, 200) ||
      'Uploaded document';

    const doc = await this.prisma.ai_knowledge_documents.create({
      data: {
        account_id: args.accountId,
        created_by: args.userId,
        title,
        content: extracted.text,
        source_type: 'file',
        file_name: args.fileName.slice(0, 255),
        byte_size: bytes.byteLength,
        status: 'indexing',
      },
      select: { id: true },
    });

    const outcome = await this.index({
      accountId: args.accountId,
      documentId: doc.id,
      content: extracted.text,
    });

    return {
      success: true,
      id: doc.id,
      title,
      truncated: extracted.truncated,
      ...outcome,
    };
  }

  /** Edit a document's title and/or content, re-indexing when content changed. */
  async update(args: {
    accountId: string;
    documentId: string;
    title?: string;
    content?: string;
  }) {
    const existing = await this.prisma.ai_knowledge_documents.findFirst({
      where: { id: args.documentId, account_id: args.accountId },
      select: { id: true },
    });
    if (!existing) {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }

    const data: Record<string, unknown> = {};
    if (args.title !== undefined) data.title = args.title;
    if (args.content !== undefined) {
      data.content = args.content;
      data.status = 'indexing';
      // A hand-edited crawl is no longer that page's content, so the
      // "re-crawl" affordance would silently discard the edit.
      data.source_type = 'text';
      data.source_url = null;
      data.byte_size = Buffer.byteLength(args.content, 'utf8');
    }

    await this.prisma.ai_knowledge_documents.update({
      where: { id: existing.id },
      data,
    });

    if (args.content === undefined) return { success: true };

    const outcome = await this.index({
      accountId: args.accountId,
      documentId: existing.id,
      content: args.content,
    });
    return { success: true, ...outcome };
  }

  /**
   * Reindex every document. Used after an embeddings key or provider
   * change, which is exactly when the corpus is `stale`.
   */
  async reindexAll(accountId: string) {
    const { key, corrupt, provider, model } = await loadEmbeddingsKey(
      this.prisma,
      accountId,
    );

    if (corrupt) {
      return {
        success: false,
        reindexed: 0,
        error:
          'Your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key). Nothing was reindexed.',
      };
    }

    const docs = await this.prisma.ai_knowledge_documents.findMany({
      where: { account_id: accountId },
      select: { id: true, content: true },
    });

    let reindexed = 0;
    let degraded = 0;

    for (const doc of docs) {
      const outcome = await this.index({
        accountId,
        documentId: doc.id,
        content: doc.content,
      });
      if (outcome.status === 'failed') {
        return {
          success: false,
          reindexed,
          total: docs.length,
          error: `Reindexed ${reindexed} of ${docs.length}, then hit an error: ${outcome.warning ?? 'unknown'}`,
        };
      }
      if (outcome.status === 'lexical') degraded += 1;
      reindexed += 1;
    }

    return {
      success: true,
      reindexed,
      degraded,
      semantic: key
        ? { provider, model: model ?? EMBEDDING_MODEL[provider] }
        : null,
    };
  }

  /**
   * Mark every embedded document stale. Called when the embeddings
   * provider or model changes: the vectors still exist but are no longer
   * comparable to new queries, and retrieval filters them out — so the
   * user needs to see "reindex me", not a corpus that appears healthy
   * while answering nothing.
   */
  async markCorpusStale(accountId: string): Promise<number> {
    const result = await this.prisma.ai_knowledge_documents.updateMany({
      where: { account_id: accountId, status: { in: ['ready', 'lexical'] } },
      data: {
        status: 'stale',
        error:
          'Embedded with a different model than this workspace now uses. Reindex to restore semantic search.',
      },
    });
    return result.count;
  }

  async remove(accountId: string, documentId: string) {
    const existing = await this.prisma.ai_knowledge_documents.findFirst({
      where: { id: documentId, account_id: accountId },
      select: { id: true },
    });
    if (!existing) {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }
    await this.prisma.ai_knowledge_documents.delete({
      where: { id: existing.id },
    });
    return { success: true };
  }
}
