import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * The onboarding queue's stages — derived from what the product records
 * today, not from the C2.0 10-step wizard (that wizard is apps/web work and
 * does not exist yet; when it persists its steps server-side, this is the
 * file that should read them).
 *
 * Stages, in order, each with the timestamp "days in stage" counts from:
 *
 *   1 Workspace details   no account_onboarding row          since signup
 *   2 Plan selection      row exists, completed_at null      since the row was written
 *   3 Channel connection  wizard done, no channel live       since completed_at
 *   4 Number registration WhatsApp connected but not         since WhatsApp connected
 *                         registered / not subscribed
 *   5 First message       a channel is live, nothing sent    since the channel went live
 *                         successfully yet
 *   6 Live                at least one outbound message that did not fail
 *
 * Stage 1/2 mirror OnboardingService.resolveStep in apps/api ('workspace'
 * = no row, 'plan' = not completed). Stage 6 uses "any outbound that did not
 * fail" rather than "confirmed delivered" because the web widget has no
 * delivery receipts — a web-only client would otherwise never go live here.
 */

export const ONBOARDING_STAGES = [
  { stage: 1, label: 'Workspace details', since: 'since signup' },
  {
    stage: 2,
    label: 'Plan selection',
    since: 'since workspace details were saved',
  },
  {
    stage: 3,
    label: 'Channel connection',
    since: 'since the welcome wizard was finished',
  },
  {
    stage: 4,
    label: 'Number registration',
    since: 'since WhatsApp was connected',
  },
  {
    stage: 5,
    label: 'First message',
    since: 'since the first channel went live',
  },
  { stage: 6, label: 'Live', since: 'since the first successful send' },
] as const;

export type OnboardingStage = 1 | 2 | 3 | 4 | 5 | 6;

type Row = {
  accountId: string;
  accountCreatedAt: Date;
  obCreatedAt: Date | null;
  obCompletedAt: Date | null;
  waStatus: string | null;
  waCreatedAt: Date | null;
  waConnectedAt: Date | null;
  waRegisteredAt: Date | null;
  waSubscribedAt: Date | null;
  waCoexistence: boolean | null;
  igStatus: string | null;
  igConnectedAt: Date | null;
  webStatus: string | null;
  webInstalledAt: Date | null;
  webLastSeenAt: Date | null;
  firstSentAt: Date | null;
};

export type OnboardingPosition = {
  accountId: string;
  stage: OnboardingStage;
  /** The timestamp days-in-stage counts from; null if none is recorded. */
  since: Date | null;
};

function earliest(...dates: (Date | null)[]): Date | null {
  const real = dates.filter((d): d is Date => d !== null);
  if (real.length === 0) return null;
  return new Date(Math.min(...real.map((d) => d.getTime())));
}

function position(row: Row): OnboardingPosition {
  const base = { accountId: row.accountId };

  if (!row.obCreatedAt) {
    return { ...base, stage: 1, since: row.accountCreatedAt };
  }
  if (!row.obCompletedAt) {
    return { ...base, stage: 2, since: row.obCreatedAt };
  }

  const waLive = row.waStatus === 'connected';
  const igLive = row.igStatus === 'connected';
  const webLive = row.webStatus === 'connected';

  if (!waLive && !igLive && !webLive) {
    return { ...base, stage: 3, since: row.obCompletedAt };
  }

  if (
    waLive &&
    ((!row.waRegisteredAt && !row.waCoexistence) || !row.waSubscribedAt)
  ) {
    return {
      ...base,
      stage: 4,
      since: row.waConnectedAt ?? row.waCreatedAt,
    };
  }

  const liveAt = earliest(
    waLive ? (row.waRegisteredAt ?? row.waConnectedAt) : null,
    igLive ? row.igConnectedAt : null,
    webLive ? (row.webInstalledAt ?? row.webLastSeenAt) : null
  );

  if (!row.firstSentAt) {
    return { ...base, stage: 5, since: liveAt };
  }
  return { ...base, stage: 6, since: row.firstSentAt };
}

/** Every workspace's onboarding position, keyed by account id. */
export async function onboardingPositions(): Promise<
  Map<string, OnboardingPosition>
> {
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    select
      a.id as "accountId",
      a.created_at as "accountCreatedAt",
      ob.created_at as "obCreatedAt",
      ob.completed_at as "obCompletedAt",
      wc.status as "waStatus",
      wc.created_at as "waCreatedAt",
      wc.connected_at as "waConnectedAt",
      wc.registered_at as "waRegisteredAt",
      wc.subscribed_apps_at as "waSubscribedAt",
      wc.coexistence as "waCoexistence",
      ig.status as "igStatus",
      ig.connected_at as "igConnectedAt",
      web.status as "webStatus",
      web.installed_at as "webInstalledAt",
      web.last_seen_at as "webLastSeenAt",
      sent.first_sent_at as "firstSentAt"
    from accounts a
    left join account_onboarding ob on ob.account_id = a.id
    left join whatsapp_config wc on wc.account_id = a.id
    left join instagram_config ig on ig.account_id = a.id
    left join web_config web on web.account_id = a.id
    left join (
      select c.account_id, min(m.created_at) as first_sent_at
      from messages m
      join conversations c on c.id = m.conversation_id
      where m.sender_type in ('agent', 'bot')
        and m.status <> 'failed'
        and m.deleted_at is null
      group by c.account_id
    ) sent on sent.account_id = a.id
  `);
  return new Map(rows.map((row) => [row.accountId, position(row)]));
}
