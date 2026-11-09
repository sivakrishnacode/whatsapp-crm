import 'server-only';

import { isLifecycleStage, type LifecycleStage } from '@/lib/lifecycle';
import type { HealthState } from '@/lib/health/rules';
import { matchesQuery, type RosterEntry } from '@/lib/queries/roster';

/**
 * The client directory's filter/sort/paginate step (C360-021), applied on the
 * server to the shared roster. Pure over its input, so the CSV export applies
 * exactly the same filter as the screen it was exported from.
 */

export type DirectorySort =
  'recent' | 'name' | 'health' | 'activity' | 'renewal' | 'tickets' | 'mrr';

export type DirectoryParams = {
  q?: string;
  stage?: string;
  health?: string;
  plan?: string;
  manager?: string;
  tier?: string;
  sort?: string;
  page?: string;
};

const HEALTH_STATES: HealthState[] = [
  'critical',
  'attention',
  'unknown',
  'healthy',
  'not_configured',
];

const HEALTH_RANK: Record<HealthState, number> = {
  critical: 0,
  attention: 1,
  unknown: 2,
  healthy: 3,
  not_configured: 4,
};

export type NormalisedFilters = {
  q: string;
  stage: LifecycleStage | 'all';
  health: HealthState | 'all';
  plan: string;
  manager: string;
  tier: string;
  sort: DirectorySort;
  page: number;
};

export function normaliseFilters(
  params: DirectoryParams,
  opts: { allowMoneySort: boolean }
): NormalisedFilters {
  const sorts: DirectorySort[] = [
    'recent',
    'name',
    'health',
    'activity',
    'renewal',
    'tickets',
    ...(opts.allowMoneySort ? (['mrr'] as const) : []),
  ];
  const page = Number(params.page);
  return {
    q: (params.q ?? '').trim().slice(0, 200),
    stage: isLifecycleStage(params.stage) ? params.stage : 'all',
    health: HEALTH_STATES.includes(params.health as HealthState)
      ? (params.health as HealthState)
      : 'all',
    plan: (params.plan ?? '').slice(0, 64),
    manager: (params.manager ?? '').slice(0, 64),
    tier: ['standard', 'priority', 'enterprise'].includes(params.tier ?? '')
      ? params.tier!
      : '',
    sort: sorts.includes(params.sort as DirectorySort)
      ? (params.sort as DirectorySort)
      : 'recent',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/**
 * Archived clients are hidden unless asked for by stage — an archive that
 * still fills the default list is not an archive.
 */
export function filterRoster(
  roster: RosterEntry[],
  f: NormalisedFilters
): RosterEntry[] {
  const rows = roster.filter((entry) => {
    if (f.stage === 'all') {
      if (entry.lifecycle.stage === 'archived') return false;
    } else if (entry.lifecycle.stage !== f.stage) {
      return false;
    }
    if (f.health !== 'all' && entry.health.overall !== f.health) return false;
    if (f.plan) {
      if (
        f.plan === 'none' ? entry.planName !== null : entry.planName !== f.plan
      ) {
        return false;
      }
    }
    if (f.manager) {
      if (
        f.manager === 'unassigned'
          ? entry.managerId !== null
          : entry.managerId !== f.manager
      ) {
        return false;
      }
    }
    if (f.tier && entry.serviceTier !== f.tier) return false;
    return matchesQuery(entry, f.q);
  });

  const time = (d: Date | null) => (d ? d.getTime() : null);
  const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) =>
    a === null && b === null
      ? 0
      : a === null
        ? 1
        : b === null
          ? -1
          : (a - b) * dir;

  const sorters: Record<
    DirectorySort,
    (a: RosterEntry, b: RosterEntry) => number
  > = {
    recent: (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    name: (a, b) => a.name.localeCompare(b.name),
    health: (a, b) =>
      HEALTH_RANK[a.health.overall] - HEALTH_RANK[b.health.overall] ||
      b.openTickets - a.openTickets,
    activity: (a, b) =>
      nullsLast(time(a.lastMessageAt), time(b.lastMessageAt), -1),
    renewal: (a, b) =>
      nullsLast(
        time(a.periodEnd ?? a.trialEndAt),
        time(b.periodEnd ?? b.trialEndAt),
        1
      ),
    tickets: (a, b) =>
      b.criticalTickets - a.criticalTickets || b.openTickets - a.openTickets,
    mrr: (a, b) => b.mrr - a.mrr,
  };

  return rows.sort(sorters[f.sort]);
}
