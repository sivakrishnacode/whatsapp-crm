import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import { ApiKeyGuard } from '../../auth/guards/api-key.guard';
import { RequireScope } from '../../auth/decorators/require-scope.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { AccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { SegmentMembershipService } from '../../common/segments/segment-membership.service';
import { ApiExceptionFilter } from '../utils/api-exception.filter';
import { ok, okList, badRequest, notFound } from '../utils/respond.util';
import { parseListParams } from '../utils/pagination.util';
import { serializeContact } from '../utils/contacts.util';

interface SegmentRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
  kind: string;
  filter: unknown;
  created_at: Date;
  updated_at: Date;
}

function serializeSegment(row: SegmentRow, memberCount?: number) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    kind: row.kind,
    // A dynamic segment's rules are part of its definition and an
    // integrator building a dashboard needs them; a static one has no
    // filter worth returning, and `{}` reads as "no rules yet" rather
    // than "not applicable".
    filter: row.kind === 'dynamic' ? row.filter : null,
    ...(memberCount === undefined ? {} : { member_count: memberCount }),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Public REST surface for segments — `contacts:read` / `contacts:write`,
 * deliberately NOT scopes of their own.
 *
 * A new scope would be absent from every key already issued, so every
 * existing integration would get a 403 the day this shipped. Segments
 * are contact data by any reading, and the two scopes that already
 * govern contact data are the honest place for them.
 *
 * Membership writes go through SegmentMembershipService for the reason
 * given in that file: the contact id in the request body is
 * attacker-supplied, Prisma bypasses RLS, and the check that makes a
 * foreign id a no-op belongs in one place rather than at every caller.
 */
@Controller('v1/segments')
@UseGuards(ApiKeyGuard)
@UseFilters(ApiExceptionFilter)
export class SegmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentMembershipService,
  ) {}

  @Get()
  @RequireScope('contacts:read')
  async list(@CurrentAccount() ctx: AccountContext) {
    const rows = await this.prisma.contact_segments.findMany({
      where: { account_id: ctx.accountId },
      orderBy: { name: 'asc' },
    });
    // No member_count here on purpose: resolving a dynamic segment is a
    // full scan of the workspace's contacts, and doing that once per
    // row turns a list call into N scans. GET /v1/segments/:id has it.
    return ok(rows.map((r) => serializeSegment(r)));
  }

  @Post()
  @RequireScope('contacts:write')
  async create(
    @CurrentAccount() ctx: AccountContext,
    @Body()
    body: {
      name?: string;
      description?: string;
      color?: string;
      kind?: string;
      filter?: unknown;
    },
  ) {
    const name = (body?.name ?? '').trim();
    if (!name) throw badRequest('name is required');
    if (name.length > 80)
      throw badRequest('name must be 80 characters or less');

    const kind = body?.kind === 'dynamic' ? 'dynamic' : 'static';

    const existing = await this.prisma.contact_segments.findFirst({
      where: {
        account_id: ctx.accountId,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    // The unique index would raise a P2002 anyway; catching it here
    // turns an opaque 500 into a sentence the integrator can act on.
    if (existing) throw badRequest(`A segment named "${name}" already exists`);

    const row = await this.prisma.contact_segments.create({
      data: {
        account_id: ctx.accountId,
        name,
        description: body?.description?.trim() || null,
        color: body?.color?.trim() || '#6366f1',
        kind,
        filter: (kind === 'dynamic' ? (body?.filter ?? {}) : {}) as object,
      },
    });
    return ok(serializeSegment(row));
  }

  @Get(':id')
  @RequireScope('contacts:read')
  async get(@CurrentAccount() ctx: AccountContext, @Param('id') id: string) {
    const row = await this.prisma.contact_segments.findFirst({
      where: { id, account_id: ctx.accountId },
    });
    if (!row) throw notFound('Segment not found');
    const members = await this.segments.resolve(ctx.accountId, id);
    return ok(serializeSegment(row, members.length));
  }

  @Patch(':id')
  @RequireScope('contacts:write')
  async update(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string | null;
      color?: string;
      filter?: unknown;
    },
  ) {
    const existing = await this.prisma.contact_segments.findFirst({
      where: { id, account_id: ctx.accountId },
      select: { id: true, kind: true },
    });
    if (!existing) throw notFound('Segment not found');

    const data: Record<string, unknown> = {};
    if (body?.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw badRequest('name cannot be empty');
      if (name.length > 80)
        throw badRequest('name must be 80 characters or less');
      data.name = name;
    }
    if (body?.description !== undefined) {
      data.description = body.description?.trim() || null;
    }
    if (body?.color !== undefined) data.color = body.color.trim() || '#6366f1';
    if (body?.filter !== undefined) {
      // `kind` is intentionally immutable. Flipping a static segment to
      // dynamic would orphan its member rows behind a filter that does
      // not describe them, and flipping the other way would invent a
      // membership list nobody chose. Delete and recreate instead.
      if (existing.kind !== 'dynamic') {
        throw badRequest('Only a dynamic segment has a filter');
      }
      data.filter = body.filter as object;
    }

    const row = await this.prisma.contact_segments.update({
      where: { id },
      data,
    });
    return ok(serializeSegment(row));
  }

  @Delete(':id')
  @RequireScope('contacts:write')
  async remove(@CurrentAccount() ctx: AccountContext, @Param('id') id: string) {
    const existing = await this.prisma.contact_segments.findFirst({
      where: { id, account_id: ctx.accountId },
      select: { id: true },
    });
    if (!existing) throw notFound('Segment not found');
    // Members cascade. The contacts themselves are untouched — a
    // segment is a label on people, not a container of them.
    await this.prisma.contact_segments.delete({ where: { id } });
    return ok({ id, deleted: true });
  }

  @Get(':id/contacts')
  @RequireScope('contacts:read')
  async listMembers(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
    @Query('limit') limitQuery?: string,
  ) {
    const segment = await this.segments.findForAccount(ctx.accountId, id);
    if (!segment) throw notFound('Segment not found');

    const { limit } = parseListParams({ limit: limitQuery });
    const ids = await this.segments.resolve(ctx.accountId, id);
    // Resolution returns ids in no meaningful order, so the page is cut
    // after a stable sort rather than before it — otherwise the same
    // request twice can return different people.
    const rows = await this.prisma.contacts.findMany({
      where: { id: { in: ids }, account_id: ctx.accountId },
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      take: limit,
      include: { contact_tags: { include: { tags: true } } },
    });
    return okList(rows.map(serializeContact), null);
  }

  @Post(':id/contacts')
  @RequireScope('contacts:write')
  async addMembers(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
    @Body() body: { contact_ids?: string[] },
  ) {
    const segment = await this.segments.findForAccount(ctx.accountId, id);
    if (!segment) throw notFound('Segment not found');
    if (segment.kind !== 'static') {
      throw badRequest(
        'Cannot add contacts to a dynamic segment; its membership comes from its filter',
      );
    }
    const contactIds = Array.isArray(body?.contact_ids) ? body.contact_ids : [];
    if (contactIds.length === 0) throw badRequest('contact_ids is required');
    if (contactIds.length > 1000) {
      throw badRequest('contact_ids is limited to 1000 per request');
    }

    const added = await this.segments.add(segment.id, contactIds, 'api');
    // `requested` vs `added` is the honest report: ids that were
    // already members, and ids belonging to another workspace, both
    // land as no-ops and the caller deserves to be able to tell.
    return ok({ segment_id: segment.id, requested: contactIds.length, added });
  }

  @Delete(':id/contacts')
  @RequireScope('contacts:write')
  async removeMembers(
    @CurrentAccount() ctx: AccountContext,
    @Param('id') id: string,
    @Body() body: { contact_ids?: string[] },
  ) {
    const segment = await this.segments.findForAccount(ctx.accountId, id);
    if (!segment) throw notFound('Segment not found');
    const contactIds = Array.isArray(body?.contact_ids) ? body.contact_ids : [];
    if (contactIds.length === 0) throw badRequest('contact_ids is required');

    const removed = await this.segments.remove(segment.id, contactIds);
    return ok({
      segment_id: segment.id,
      requested: contactIds.length,
      removed,
    });
  }
}
