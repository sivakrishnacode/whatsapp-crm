import type { Metadata } from 'next';

import { HealthBadge } from '@/components/ops/badges';
import {
  TicketCreateForm,
  type TicketDefaults,
} from '@/components/support/ticket-create-form';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Callout, PageHeader } from '@/components/ui/page';
import { requireCapability } from '@/lib/auth';
import { getAccountHealth } from '@/lib/health/evidence';
import type { HealthCheck, HealthKey } from '@/lib/health/rules';
import { formatAgo, formatDateTime } from '@/lib/format';
import { prisma } from '@/lib/prisma';
import { listStaff } from '@/lib/queries/staff';
import { getSettings } from '@/lib/settings-store';
import { SEVERITIES, TICKET_CATEGORIES, TICKET_SOURCES } from '@/lib/sla';

export const metadata: Metadata = {
  title: 'New ticket · Converse360 Control Center',
};

type Search = {
  accountId?: string;
  category?: string;
  severity?: string;
  incident?: string;
  subject?: string;
  source?: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which queue an incident lands in, and the ticket category it maps to. */
const INCIDENT_ROUTING: Record<HealthKey, { category: string; tier: string }> =
  {
    wa_connection: { category: 'meta_channel', tier: 'L2' },
    wa_token: { category: 'meta_channel', tier: 'L2' },
    wa_quality: { category: 'meta_channel', tier: 'L2' },
    delivery: { category: 'messaging', tier: 'L2' },
    templates: { category: 'templates', tier: 'L1' },
    instagram: { category: 'meta_channel', tier: 'L2' },
    web_widget: { category: 'meta_channel', tier: 'L1' },
    webhooks: { category: 'api_integration', tier: 'L3' },
    google_bridge: { category: 'api_integration', tier: 'L3' },
    ecommerce: { category: 'api_integration', tier: 'L3' },
    api_keys: { category: 'api_integration', tier: 'L3' },
    ai_credits: { category: 'ai', tier: 'L1' },
    billing: { category: 'billing', tier: 'billing' },
  };

/**
 * Open a ticket. Prefilled by whoever linked here:
 *   - the incident monitor: `?accountId=…&incident=<health key>` — subject,
 *     description, category, tier and severity come from the failing check,
 *     and a diagnostic snapshot is attached at submission.
 *   - the onboarding queue: `?accountId=…&category=onboarding`
 *   - a client's 360: `?accountId=…`
 */
export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const staff = await requireCapability('tickets.work');
  const params = await searchParams;

  const accountId =
    params.accountId && UUID_RE.test(params.accountId) ? params.accountId : '';

  const [account, staffList, settings, clients] = await Promise.all([
    accountId
      ? prisma.account.findUnique({
          where: { id: accountId },
          select: { id: true, name: true },
        })
      : null,
    listStaff({ activeOnly: true }),
    getSettings(),
    accountId
      ? Promise.resolve([] as { id: string; name: string }[])
      : prisma.account.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
  ]);

  let check: HealthCheck | null = null;
  let evaluatedAt: Date | null = null;
  const incidentKey =
    account &&
    params.incident &&
    Object.hasOwn(INCIDENT_ROUTING, params.incident)
      ? (params.incident as HealthKey)
      : null;
  if (account && incidentKey) {
    const health = await getAccountHealth(account.id);
    check = health?.checks.find((c) => c.key === incidentKey) ?? null;
    evaluatedAt = health?.evaluatedAt ?? null;
  }

  const routing = incidentKey ? INCIDENT_ROUTING[incidentKey] : null;
  const pick = <T extends string>(
    value: string | undefined,
    allowed: readonly T[],
    fallback: T
  ): T =>
    (allowed as readonly string[]).includes(value ?? '')
      ? (value as T)
      : fallback;

  const defaults: TicketDefaults = {
    accountId: account?.id ?? '',
    subject:
      params.subject?.slice(0, 200) ??
      (check
        ? `${check.label}: ${check.state === 'critical' ? 'critical' : 'needs attention'}`
        : ''),
    description: check
      ? [
          `Evidence: ${check.evidence}`,
          check.action ? `Suggested next step: ${check.action}` : null,
        ]
          .filter(Boolean)
          .join('\n\n')
      : '',
    category: pick(
      params.category,
      TICKET_CATEGORIES,
      (routing?.category as (typeof TICKET_CATEGORIES)[number]) ?? 'other'
    ),
    severity: pick(
      params.severity,
      SEVERITIES,
      check?.state === 'critical' ? 'high' : 'normal'
    ),
    tier: routing?.tier ?? (params.category === 'billing' ? 'billing' : 'L1'),
    source: pick(
      params.source,
      TICKET_SOURCES,
      incidentKey
        ? 'monitoring'
        : params.category === 'onboarding'
          ? 'onboarding'
          : 'staff'
    ),
    requester: '',
    incident: incidentKey ?? '',
  };

  const sla = settings.sla;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/support', label: 'Support Desk' }}
        title="New ticket"
        description={
          account
            ? `For ${account.name}.`
            : 'Raise a ticket for a client, or an internal one.'
        }
      />

      {params.accountId && !account ? (
        <Callout tone="warn" title="That client was not found">
          The link named a workspace that no longer exists. Pick a client below,
          or open an internal ticket.
        </Callout>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardBody>
            <TicketCreateForm
              defaults={defaults}
              clients={clients}
              staff={staffList.map((m) => ({ id: m.id, name: m.name }))}
              lockedClientName={account?.name ?? null}
              canSelfAssign={Boolean(staff.id)}
            />
          </CardBody>
        </Card>

        <div className="space-y-6">
          {check ? (
            <Card>
              <CardHeader
                eyebrow="Diagnostic snapshot"
                title={check.label}
                action={<HealthBadge state={check.state} />}
              />
              <CardBody className="space-y-3 text-sm">
                <p className="text-ink-2">{check.evidence}</p>
                {check.action ? (
                  <p className="text-muted text-xs leading-relaxed">
                    <strong className="text-ink-2">Next step:</strong>{' '}
                    {check.action}
                  </p>
                ) : null}
                <p className="text-muted text-xs">
                  Evidence from{' '}
                  {check.checkedAt
                    ? `${formatDateTime(check.checkedAt)} (${formatAgo(check.checkedAt)})`
                    : 'no recorded time'}
                  {evaluatedAt ? ` · evaluated ${formatAgo(evaluatedAt)}` : ''}.
                  The server re-reads this check when the ticket is opened and
                  attaches it to the ticket.
                </p>
              </CardBody>
            </Card>
          ) : incidentKey ? (
            <Callout tone="info">
              That check is no longer reported for this client. You can still
              open the ticket; no snapshot will be attached.
            </Callout>
          ) : null}

          <Card>
            <CardHeader
              title="SLA targets"
              description="Set from the severity at creation. Clocks run 24×7 and do not pause while waiting on the customer."
            />
            <CardBody>
              <dl className="divide-line divide-y text-sm">
                {SEVERITIES.map((severity) => (
                  <div
                    key={severity}
                    className="flex justify-between gap-4 py-2 first:pt-0 last:pb-0"
                  >
                    <dt className="text-ink-2 capitalize">{severity}</dt>
                    <dd className="text-muted tabular text-xs">
                      respond {minutesLabel(sla[severity].firstResponseMinutes)}{' '}
                      · resolve {minutesLabel(sla[severity].resolutionMinutes)}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / (60 * 24))} d`;
}
