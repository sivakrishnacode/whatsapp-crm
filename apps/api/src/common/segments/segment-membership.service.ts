import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Which surface filed a contact into a segment.
 *
 * Mirrors `contact_segment_members_source_chk` (migration 076). Widening
 * this list means widening that constraint too, or the insert fails at
 * runtime — the same contract `contact-source.ts` has with
 * `contacts_source_chk`.
 */
export const SEGMENT_MEMBER_SOURCES = [
  'manual',
  'import',
  'automation',
  'flow',
  'api',
  'broadcast',
] as const;

export type SegmentMemberSource = (typeof SEGMENT_MEMBER_SOURCES)[number];

export interface SegmentRef {
  id: string;
  name: string;
  kind: 'static' | 'dynamic';
}

/**
 * The one place apps/api changes segment membership or resolves a
 * segment to people.
 *
 * WHY A SERVICE RATHER THAN A PRISMA CALL AT EACH SITE
 *
 *   Five surfaces put contacts into segments — the automation step, the
 *   flow node, CSV import, the public API and (soon) a broadcast's own
 *   follow-up list. Every one of them receives its contact id from
 *   somewhere the account does not control: a Meta webhook payload, an
 *   API request body, an uploaded file. Prisma connects as the database
 *   owner, so RLS is not protecting any of them, and the check that
 *   makes a foreign contact id a no-op has to be written out by hand
 *   every single time. Writing it once is the only version of that
 *   which stays true.
 *
 *   The checks live in SQL (`add_contacts_to_segment`, migration 076)
 *   rather than here, so the browser — which writes membership directly
 *   through PostgREST — gets exactly the same guarantees rather than a
 *   parallel implementation that drifts.
 *
 * ⚠ `resolve()` is the ONLY correct way to turn a segment into people.
 *   Reading `contact_segment_members` directly looks like it works and
 *   silently returns nothing for a dynamic segment, whose membership is
 *   computed from its filter and never stored.
 */
@Injectable()
export class SegmentMembershipService {
  private readonly logger = new Logger(SegmentMembershipService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The segment, if it belongs to this account.
   *
   * Every caller must go through this before acting on a segment id
   * that arrived from a config blob or a request body. The SQL function
   * pins the CONTACT to the segment's account; this pins the SEGMENT to
   * the caller's. Both halves are needed: without this one, an
   * automation whose config named another tenant's segment would file
   * that tenant's own contacts into it quite happily.
   */
  async findForAccount(
    accountId: string,
    segmentId: string,
  ): Promise<SegmentRef | null> {
    if (!segmentId) return null;
    const row = await this.prisma.contact_segments.findFirst({
      where: { id: segmentId, account_id: accountId },
      select: { id: true, name: true, kind: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind === 'dynamic' ? 'dynamic' : 'static',
    };
  }

  /**
   * Add contacts to a static segment. Returns how many rows were
   * actually created — already-members count as 0, which is what lets a
   * caller log "added" versus "already there" honestly.
   *
   * Throws when the segment is dynamic. That is a category error the
   * caller should surface, not swallow: someone pointed an automation
   * at a saved filter and expects it to be doing something.
   */
  async add(
    segmentId: string,
    contactIds: string[],
    source: SegmentMemberSource,
  ): Promise<number> {
    const ids = uniqueIds(contactIds);
    if (ids.length === 0) return 0;
    const rows = await this.prisma.$queryRaw<{ added: number }[]>`
      SELECT add_contacts_to_segment(
        ${segmentId}::uuid,
        ${ids}::uuid[],
        ${source}::text
      ) AS added
    `;
    return Number(rows[0]?.added ?? 0);
  }

  /** Remove contacts from a static segment. Returns rows deleted. */
  async remove(segmentId: string, contactIds: string[]): Promise<number> {
    const ids = uniqueIds(contactIds);
    if (ids.length === 0) return 0;
    const rows = await this.prisma.$queryRaw<{ removed: number }[]>`
      SELECT remove_contacts_from_segment(
        ${segmentId}::uuid,
        ${ids}::uuid[]
      ) AS removed
    `;
    return Number(rows[0]?.removed ?? 0);
  }

  /**
   * Every contact id in a segment, whichever kind it is.
   *
   * Account-scoped by the segment lookup rather than by the query: the
   * SQL resolver already pins a dynamic segment's scan to its own
   * account, and a static segment can only contain contacts that passed
   * the same check on the way in.
   */
  async resolve(accountId: string, segmentId: string): Promise<string[]> {
    const segment = await this.findForAccount(accountId, segmentId);
    if (!segment) return [];
    const rows = await this.prisma.$queryRaw<{ contact_id: string }[]>`
      SELECT contact_id FROM resolve_segment_contact_ids(${segmentId}::uuid)
    `;
    return rows.map((r) => r.contact_id);
  }

  /**
   * Union of several segments, de-duplicated.
   *
   * Union rather than intersection because that is what selecting two
   * audiences in a broadcast picker means to the person selecting them:
   * "send to these people and also those people".
   */
  async resolveMany(
    accountId: string,
    segmentIds: string[],
  ): Promise<string[]> {
    const ids = uniqueIds(segmentIds);
    if (ids.length === 0) return [];
    const out = new Set<string>();
    for (const id of ids) {
      for (const contactId of await this.resolve(accountId, id)) {
        out.add(contactId);
      }
    }
    return [...out];
  }

  /** Segments a single contact is an explicit member of (static only). */
  async segmentsForContact(
    accountId: string,
    contactId: string,
  ): Promise<SegmentRef[]> {
    const rows = await this.prisma.contact_segment_members.findMany({
      where: {
        contact_id: contactId,
        segment: { account_id: accountId },
      },
      select: { segment: { select: { id: true, name: true, kind: true } } },
    });
    return rows.map((r) => ({
      id: r.segment.id,
      name: r.segment.name,
      kind: r.segment.kind === 'dynamic' ? 'dynamic' : 'static',
    }));
  }
}

/**
 * Postgres would reject a NULL inside a uuid[], and a duplicate id turns
 * a set-based insert into a self-conflict for no reason. Both are things
 * a webhook payload or a CSV can produce, so neither is defensive.
 */
function uniqueIds(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}
