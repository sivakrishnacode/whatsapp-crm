import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { KnowledgeSourceService } from '../services/knowledge-source.service';
import { SUPPORTED_UPLOAD_EXTENSIONS } from '../lib/extract';

const MAX_TITLE = 200;
const MAX_CONTENT = 200_000;
/** ~14 MB of base64 decodes to a little over the 10 MB file limit, so an
 *  oversized file is rejected with a message naming MB rather than a
 *  base64 length no user can reason about. */
const MAX_BASE64 = 14_000_000;

/**
 * The agent's knowledge base — one corpus, three ways in: pasted text, a
 * crawled page, an uploaded file.
 *
 * Reads are member-level (the inbox shows what the agent knows); writes
 * are admin+, matching the RLS policies on `ai_knowledge_documents`.
 */
@Controller('ai/knowledge')
@UseGuards(SupabaseAuthGuard)
export class AiKnowledgeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeSourceService,
  ) {}

  @Get()
  async list(@CurrentAccount() account: SupabaseAccountContext) {
    return this.knowledge.list(account.accountId);
  }

  /** Pasted text. */
  @Post()
  @RequireRole('admin')
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { title?: string; content?: string },
  ) {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!title || !content) {
      throw new HttpException(
        'title and content are required',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.knowledge.createFromText({
      accountId: account.accountId,
      userId: account.userId,
      title: title.slice(0, MAX_TITLE),
      content: content.slice(0, MAX_CONTENT),
    });
  }

  /**
   * Crawl one page. Pass `document_id` to re-crawl an existing source,
   * which replaces its content in place rather than leaving two copies of
   * the same page in the corpus.
   */
  @Post('crawl')
  @RequireRole('admin')
  async crawl(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { url?: string; document_id?: string },
  ) {
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!url) {
      throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
    }

    return this.knowledge.createFromUrl({
      accountId: account.accountId,
      userId: account.userId,
      url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
      documentId: body?.document_id,
    });
  }

  /**
   * Upload a file. Base64 in a JSON body, matching `POST /ads/media` —
   * this API has no multipart parser, and adding one for a single endpoint
   * would be the larger change.
   */
  @Post('upload')
  @RequireRole('admin')
  async upload(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: { file_name?: string; data_base64?: string; title?: string },
  ) {
    const fileName =
      typeof body?.file_name === 'string' ? body.file_name.trim() : '';
    const data =
      typeof body?.data_base64 === 'string' ? body.data_base64 : '';

    if (!fileName || !data) {
      throw new HttpException(
        'file_name and data_base64 are required',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (data.length > MAX_BASE64) {
      throw new HttpException(
        {
          error: 'That file is too large — the limit is 10 MB.',
          code: 'upload_too_large',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.knowledge.createFromFile({
      accountId: account.accountId,
      userId: account.userId,
      fileName,
      dataBase64: data,
      title: body?.title,
    });
  }

  /** Which file types `upload` accepts — the UI reads this for its picker. */
  @Get('upload/formats')
  formats() {
    return {
      extensions: SUPPORTED_UPLOAD_EXTENSIONS,
      max_bytes: 10 * 1024 * 1024,
    };
  }

  @Post('reindex')
  @RequireRole('admin')
  async reindex(@CurrentAccount() account: SupabaseAccountContext) {
    return this.knowledge.reindexAll(account.accountId);
  }

  @Get(':id')
  async get(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const document = await this.prisma.ai_knowledge_documents.findFirst({
      where: { id, account_id: account.accountId },
      select: {
        id: true,
        title: true,
        content: true,
        source_type: true,
        source_url: true,
        file_name: true,
        status: true,
        error: true,
        chunk_count: true,
        indexed_at: true,
        updated_at: true,
      },
    });

    if (!document) throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    return document;
  }

  @Patch(':id')
  @RequireRole('admin')
  async update(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { title?: string; content?: string },
  ) {
    const title =
      typeof body?.title === 'string' ? body.title.trim() : undefined;
    const content =
      typeof body?.content === 'string' ? body.content.trim() : undefined;

    if (title === undefined && content === undefined) {
      throw new HttpException('Nothing to update', HttpStatus.BAD_REQUEST);
    }
    if (title !== undefined && !title) {
      throw new HttpException('title cannot be empty', HttpStatus.BAD_REQUEST);
    }
    if (content !== undefined && !content) {
      throw new HttpException('content cannot be empty', HttpStatus.BAD_REQUEST);
    }

    return this.knowledge.update({
      accountId: account.accountId,
      documentId: id,
      title: title?.slice(0, MAX_TITLE),
      content: content?.slice(0, MAX_CONTENT),
    });
  }

  @Delete(':id')
  @RequireRole('admin')
  async remove(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.knowledge.remove(account.accountId, id);
  }
}
