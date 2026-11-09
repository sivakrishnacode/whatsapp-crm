import Link from 'next/link';

import { HealthBadge } from '@/components/ops/badges';
import { formatAgo, formatDateTime } from '@/lib/format';
import { isIncident, type HealthCheck } from '@/lib/health/rules';

const CATEGORY_LABEL: Record<HealthCheck['category'], string> = {
  meta: 'Meta & WhatsApp',
  messaging: 'Messaging',
  templates: 'Templates',
  channels: 'Other channels',
  integrations: 'Integrations & API',
  ai: 'AI',
  billing: 'Billing',
};

/**
 * Health checks as the handoff specifies them: state, evidence, the time of
 * the evidence, and a next action. Grouped by category, worst first within a
 * group. `hideUnconfigured` folds "not configured" rows into one line — on
 * a busy screen they are context, not news.
 */
export function HealthChecks({
  checks,
  accountId,
  canTicket,
  hideUnconfigured = false,
}: {
  checks: HealthCheck[];
  accountId: string;
  canTicket: boolean;
  hideUnconfigured?: boolean;
}) {
  const rank = {
    critical: 0,
    attention: 1,
    unknown: 2,
    healthy: 3,
    not_configured: 4,
  };
  const visible = hideUnconfigured
    ? checks.filter((c) => c.state !== 'not_configured')
    : checks;
  const hidden = checks.length - visible.length;

  const groups = new Map<HealthCheck['category'], HealthCheck[]>();
  for (const check of [...visible].sort(
    (a, b) => rank[a.state] - rank[b.state]
  )) {
    groups.set(check.category, [...(groups.get(check.category) ?? []), check]);
  }

  return (
    <div className="divide-line divide-y">
      {[...groups.entries()].map(([category, items]) => (
        <div key={category} className="px-5 py-3">
          <p className="text-muted mb-1 text-[11px] font-semibold tracking-wider uppercase">
            {CATEGORY_LABEL[category]}
          </p>
          <ul className="divide-line divide-y">
            {items.map((check) => (
              <li
                key={check.key}
                className="grid gap-2 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-start"
              >
                <div className="flex flex-wrap items-center gap-2 sm:block sm:space-y-1.5">
                  <p className="text-ink text-sm font-semibold">
                    {check.label}
                  </p>
                  <HealthBadge state={check.state} />
                </div>
                <div className="min-w-0 text-sm">
                  <p className="text-ink-2 leading-relaxed">{check.evidence}</p>
                  {check.action ? (
                    <p className="text-muted mt-1 text-xs leading-relaxed">
                      <span className="text-ink-2 font-semibold">Next: </span>
                      {check.action}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs sm:flex-col sm:items-end">
                  <span
                    className="text-muted whitespace-nowrap"
                    title={
                      check.checkedAt
                        ? formatDateTime(check.checkedAt)
                        : undefined
                    }
                  >
                    {check.checkedAt
                      ? `Evidence ${formatAgo(check.checkedAt)}`
                      : 'No evidence'}
                  </span>
                  {canTicket && isIncident(check) ? (
                    <Link
                      href={`/support/new?accountId=${accountId}&incident=${check.key}`}
                      className="text-primary font-semibold whitespace-nowrap hover:underline"
                    >
                      Open ticket →
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {hidden > 0 ? (
        <p className="text-muted px-5 py-3 text-xs">
          {hidden} check{hidden === 1 ? '' : 's'} not configured for this
          workspace (channel or feature not set up).
        </p>
      ) : null}
    </div>
  );
}
