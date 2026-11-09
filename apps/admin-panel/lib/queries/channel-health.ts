import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * Fleet-wide Meta error codes for the Meta & Channel Health screen.
 *
 * The code and title come from `messages.metadata.error`, which the API
 * writes from Meta's own failure payload (commit 8cf02de). Grouped across
 * every workspace so a platform-wide pattern (Meta throttling marketing
 * messages everywhere at once) is visible as one row rather than as
 * scattered per-client incidents.
 */

export type MetaErrorRow = {
  code: number;
  title: string | null;
  failures: number;
  workspaces: number;
  workspaceNames: string;
  lastSeen: Date;
};

export async function topMetaErrors(days = 7): Promise<{
  rows: MetaErrorRow[];
  failedTotal: number;
  withoutCode: number;
}> {
  const window = `${days} days`;
  const [rows, [totals]] = await Promise.all([
    prisma.$queryRaw<MetaErrorRow[]>(Prisma.sql`
      select
        (m.metadata->'error'->>'code')::int as "code",
        max(m.metadata->'error'->>'title') as "title",
        (count(*))::int as "failures",
        (count(distinct c.account_id))::int as "workspaces",
        string_agg(distinct a.name, ', ') as "workspaceNames",
        max(m.created_at) as "lastSeen"
      from messages m
      join conversations c on c.id = m.conversation_id
      join accounts a on a.id = c.account_id
      where m.status = 'failed'
        and m.created_at >= now() - ${window}::interval
        and (m.metadata->'error'->>'code') ~ '^[0-9]{1,9}$'
      group by 1
      order by "failures" desc, "code"
      limit 15
    `),
    prisma.$queryRaw<{ failedTotal: number; withoutCode: number }[]>(
      Prisma.sql`
        select
          (count(*))::int as "failedTotal",
          (count(*) filter (
            where coalesce(m.metadata->'error'->>'code', '') !~ '^[0-9]{1,9}$'
          ))::int as "withoutCode"
        from messages m
        where m.status = 'failed'
          and m.created_at >= now() - ${window}::interval
      `
    ),
  ]);
  return {
    rows,
    failedTotal: totals?.failedTotal ?? 0,
    withoutCode: totals?.withoutCode ?? 0,
  };
}
