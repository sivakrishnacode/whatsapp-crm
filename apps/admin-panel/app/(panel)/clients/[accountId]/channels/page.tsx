import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { HealthChecks } from '@/components/clients/health-checks';
import { HEALTH_STYLE } from '@/components/ops/badges';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { ButtonLink, ScopeLine } from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import { can, requireCapability } from '@/lib/auth';
import { adminTimezone } from '@/lib/env';
import { formatAgo, formatDate, formatDateTime } from '@/lib/format';
import { getAccountHealth } from '@/lib/health/evidence';
import type { HealthState } from '@/lib/health/rules';
import { isUuid } from '@/lib/ids';
import { getChannels } from '@/lib/queries/workspaces';

export const metadata: Metadata = { title: 'Channels & health · Customer 360' };

/**
 * Meta connectivity and account health for one client (C360-031). The
 * "re-evaluate" button reloads this page, which runs the rules again over
 * whatever the API's own jobs last wrote — the Control Center holds no
 * customer token and never calls Meta itself, so it cannot run a live probe
 * and does not pretend to.
 */
export default async function ClientChannelsPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const staff = await requireCapability('clients.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();

  const [health, channels] = await Promise.all([
    getAccountHealth(accountId),
    getChannels(accountId),
  ]);
  if (!health) notFound();

  const counts = health.checks.reduce(
    (acc, c) => ({ ...acc, [c.state]: (acc[c.state] ?? 0) + 1 }),
    {} as Partial<Record<HealthState, number>>
  );
  const wa = health.evidence.wa;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScopeLine>
          <span>
            Evaluated {formatDateTime(health.evaluatedAt)} ({adminTimezone()})
            from stored evidence
          </span>
          <span aria-hidden>·</span>
          <span>
            Live probes run in the API&apos;s own jobs (limits sync every 6 h,
            webhook pipeline)
          </span>
        </ScopeLine>
        <ButtonLink href={`/clients/${accountId}/channels`} size="sm">
          Re-evaluate now
        </ButtonLink>
      </div>

      <StatRow columns={5}>
        {(
          [
            'critical',
            'attention',
            'unknown',
            'healthy',
            'not_configured',
          ] as const
        ).map((state) => (
          <StatTile
            key={state}
            label={HEALTH_STYLE[state].label}
            value={String(counts[state] ?? 0)}
            tone={
              state === 'critical'
                ? 'critical'
                : state === 'attention'
                  ? 'warning'
                  : state === 'healthy'
                    ? 'good'
                    : 'neutral'
            }
            context={
              state === 'unknown'
                ? 'missing or stale evidence — not healthy'
                : undefined
            }
          />
        ))}
      </StatRow>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader
            title="All health checks"
            description="Each check shows what was seen, when that evidence was recorded, and the next action."
          />
          <HealthChecks
            checks={health.checks}
            accountId={accountId}
            canTicket={can(staff, 'tickets.work')}
          />
        </Card>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="WhatsApp" />
            <CardBody>
              {wa ? (
                <Facts
                  items={[
                    { label: 'Status', value: wa.status },
                    {
                      label: 'Phone number ID',
                      value: (
                        <span className="font-mono text-xs">
                          {wa.phoneNumberId}
                        </span>
                      ),
                    },
                    {
                      label: 'WABA ID',
                      value: (
                        <span className="font-mono text-xs">
                          {wa.wabaId ?? '—'}
                        </span>
                      ),
                    },
                    {
                      label: 'Connected via',
                      value:
                        wa.connectionMethod === 'embedded_signup'
                          ? 'Embedded Signup'
                          : 'Manual',
                      hint: wa.coexistence
                        ? 'coexistence with the WhatsApp Business app'
                        : undefined,
                    },
                    { label: 'Connected', value: formatDate(wa.connectedAt) },
                    {
                      label: 'Registered (Cloud API)',
                      value: wa.registeredAt
                        ? formatDate(wa.registeredAt)
                        : 'No',
                    },
                    {
                      label: 'WABA subscribed to app',
                      value: wa.subscribedAppsAt
                        ? formatDate(wa.subscribedAppsAt)
                        : 'No',
                    },
                    {
                      label: 'Messaging tier',
                      value: wa.tier ?? '—',
                      hint: wa.quality ? `quality ${wa.quality}` : undefined,
                    },
                    {
                      label: 'Limits last synced',
                      value: wa.limitsSyncedAt
                        ? formatAgo(wa.limitsSyncedAt)
                        : 'Never',
                      hint: wa.limitsSyncedAt
                        ? formatDateTime(wa.limitsSyncedAt)
                        : undefined,
                    },
                    {
                      label: 'Token expiry',
                      value: wa.tokenExpiresAt
                        ? formatDate(wa.tokenExpiresAt)
                        : 'None recorded',
                    },
                    ...(wa.lastRegistrationError
                      ? [
                          {
                            label: 'Last registration error',
                            value: wa.lastRegistrationError,
                          },
                        ]
                      : []),
                  ]}
                />
              ) : (
                <p className="text-muted text-sm">
                  No WhatsApp number connected. The customer connects it through
                  Meta Embedded Signup — a Meta owner action support can guide
                  but not perform.
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Other channels" />
            <CardBody>
              <Facts
                items={[
                  {
                    label: 'Instagram',
                    value: channels.instagramStatus ?? 'Not connected',
                    hint: channels.instagramUsername
                      ? `@${channels.instagramUsername}`
                      : undefined,
                  },
                  {
                    label: 'Web widget',
                    value: channels.webStatus ?? 'Not set up',
                  },
                  {
                    label: 'Meta Ads',
                    value: channels.adsConnected
                      ? channels.adsFundingOk
                        ? 'Connected, funded'
                        : 'Connected, no funding source'
                      : 'Not connected',
                  },
                ]}
              />
              <DerivedNote>
                No access token, webhook secret or script URL is ever read by
                this panel — health is judged from status columns and timestamps
                only.
              </DerivedNote>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
