import type { Metadata } from 'next';
import Link from 'next/link';

import { HEALTH_STYLE, HealthBadge } from '@/components/ops/badges';
import { Pill } from '@/components/ui/badge';
import {
  Card,
  CardHeader,
  DerivedNote,
  EmptyState,
} from '@/components/ui/card';
import { PageHeader, ScopeLine, Segmented } from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import {
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
} from '@/components/ui/table';
import { requireCapability } from '@/lib/auth';
import { adminTimezone } from '@/lib/env';
import type { HealthKey, HealthState } from '@/lib/health/rules';
import { formatAgo, formatDateTime, formatNumber } from '@/lib/format';
import { topMetaErrors } from '@/lib/queries/channel-health';
import { getRoster, type RosterEntry } from '@/lib/queries/roster';
import { getSettings } from '@/lib/settings-store';
import { requestNow } from '@/lib/clock';

export const metadata: Metadata = {
  title: 'Meta & Channel Health · Converse360 Control Center',
};

const COLUMNS: { key: HealthKey; label: string }[] = [
  { key: 'wa_connection', label: 'Connection' },
  { key: 'wa_token', label: 'Authorization' },
  { key: 'wa_quality', label: 'Quality & tier' },
  { key: 'delivery', label: 'Delivery (7d)' },
  { key: 'templates', label: 'Templates' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'web_widget', label: 'Web widget' },
];

const STATES: HealthState[] = [
  'critical',
  'attention',
  'unknown',
  'healthy',
  'not_configured',
];

/** A workspace belongs on this screen once it has any channel at all. */
function hasChannel(entry: RosterEntry): boolean {
  const e = entry.health.evidence;
  return Boolean(e.wa || e.ig || (e.web && e.web.status !== 'disconnected'));
}

function qualityTone(quality: string | null) {
  const q = (quality ?? '').toUpperCase();
  if (q === 'GREEN' || q === 'HIGH')
    return { tone: 'good' as const, glyph: '●' };
  if (q === 'YELLOW' || q === 'MEDIUM')
    return { tone: 'warn' as const, glyph: '▲' };
  if (q === 'RED' || q === 'LOW') return { tone: 'bad' as const, glyph: '■' };
  return { tone: 'neutral' as const, glyph: '?' };
}

/**
 * The Meta side of the fleet (C360-031): each workspace's WhatsApp
 * connection, authorization, quality and tier, delivery and templates, plus
 * Instagram and the web widget — and which Meta error codes are failing
 * messages platform-wide this week.
 */
export default async function ChannelHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  await requireCapability('clients.read');
  const { state: rawState } = await searchParams;
  const filter = (STATES as string[]).includes(rawState ?? '')
    ? (rawState as HealthState)
    : null;

  const [roster, errors, settings] = await Promise.all([
    getRoster(),
    topMetaErrors(7),
    getSettings(),
  ]);

  const withChannel = roster.filter(hasChannel);
  const cells = (entry: RosterEntry) =>
    COLUMNS.map((column) =>
      entry.health.checks.find((c) => c.key === column.key)!
    );

  const counts = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<
    HealthState,
    number
  >;
  for (const entry of withChannel) {
    for (const check of cells(entry)) counts[check.state] += 1;
  }

  const rows = withChannel
    .filter((entry) =>
      filter ? cells(entry).some((check) => check.state === filter) : true
    )
    .sort((a, b) => {
      const worst = (entry: RosterEntry) =>
        Math.min(...cells(entry).map((c) => STATES.indexOf(c.state)));
      return worst(a) - worst(b) || a.name.localeCompare(b.name);
    });

  const numbers = withChannel
    .filter((entry) => entry.health.evidence.wa)
    .map((entry) => ({ entry, wa: entry.health.evidence.wa! }));
  const staleMs = settings.healthStaleHours * 3_600_000;
  const now = requestNow().getTime();
  const evaluatedAt = roster[0]?.health.evaluatedAt ?? new Date();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Meta & Channel Health"
        description="Connection, authorization, quality, delivery and templates for every client with a channel — judged from what the API’s own jobs last recorded."
      />

      <StatRow columns={5}>
        <StatTile
          label="Clients with a channel"
          value={formatNumber(withChannel.length)}
          context={`of ${formatNumber(roster.length)} workspaces`}
        />
        <StatTile
          label="Critical checks"
          value={formatNumber(counts.critical)}
          tone={counts.critical > 0 ? 'critical' : 'good'}
          href="/health?state=critical"
        />
        <StatTile
          label="Attention"
          value={formatNumber(counts.attention)}
          tone={counts.attention > 0 ? 'warning' : 'neutral'}
          href="/health?state=attention"
        />
        <StatTile
          label="Unknown / stale"
          value={formatNumber(counts.unknown)}
          context="Not healthy — just not visible"
          href="/health?state=unknown"
        />
        <StatTile
          label="Healthy"
          value={formatNumber(counts.healthy)}
          href="/health?state=healthy"
        />
      </StatRow>

      <ScopeLine>
        <span>
          Evaluated {formatDateTime(evaluatedAt)} ({adminTimezone()}).
        </span>
        <span aria-hidden>·</span>
        <span>
          Quality and tier sync every 6 h; older than{' '}
          {settings.healthStaleHours} h reads as Unknown.
        </span>
        <span aria-hidden>·</span>
        <span>
          The Control Center holds no Meta token and never calls Meta.
        </span>
      </ScopeLine>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Show clients with"
          active={filter ?? 'all'}
          options={[
            { value: 'all', label: 'All', href: '/health' },
            ...(['critical', 'attention', 'unknown'] as const).map((s) => ({
              value: s,
              label: `Any ${HEALTH_STYLE[s].label.toLowerCase()}`,
              href: `/health?state=${s}`,
            })),
          ]}
        />
      </div>

      <Card>
        <CardHeader
          title="Channel matrix"
          description="Worst first. Hover a state for the evidence behind it; open a client for the full check list."
        />
        {rows.length === 0 ? (
          <EmptyState
            title={
              filter ? 'Nothing in this state' : 'No channels connected yet'
            }
          >
            {filter
              ? 'No client has a check in this state right now.'
              : 'Clients appear here once they connect WhatsApp, Instagram or the web widget.'}
          </EmptyState>
        ) : (
          <TableWrap>
            <Table minWidth="78rem">
              <THead>
                <tr>
                  <TH>Client</TH>
                  {COLUMNS.map((column) => (
                    <TH key={column.key}>{column.label}</TH>
                  ))}
                </tr>
              </THead>
              <TBody>
                {rows.map((entry) => (
                  <TR key={entry.accountId}>
                    <TD className="max-w-[14rem]">
                      <Link
                        href={`/clients/${entry.accountId}/channels`}
                        className="text-ink block truncate font-semibold underline-offset-2 hover:underline"
                      >
                        {entry.name}
                      </Link>
                      <span className="text-muted text-xs">
                        {entry.health.evidence.wa?.tier ?? 'no WhatsApp tier'}
                      </span>
                    </TD>
                    {cells(entry).map((check) => (
                      <TD key={check.key}>
                        <HealthBadge
                          state={check.state}
                          title={`${check.evidence}${check.action ? ` — ${check.action}` : ''}`}
                        />
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="WhatsApp numbers: quality & tier"
            description="As last synced from Meta by the API’s 6-hourly messaging-limits job."
          />
          {numbers.length === 0 ? (
            <EmptyState>No WhatsApp number is connected yet.</EmptyState>
          ) : (
            <TableWrap>
              <Table minWidth="40rem">
                <THead>
                  <tr>
                    <TH>Client</TH>
                    <TH>Number ID</TH>
                    <TH>Tier</TH>
                    <TH>Quality</TH>
                    <TH align="right">Synced</TH>
                  </tr>
                </THead>
                <TBody>
                  {numbers.map(({ entry, wa }) => {
                    const stale =
                      !wa.limitsSyncedAt ||
                      now - wa.limitsSyncedAt.getTime() > staleMs;
                    const q = qualityTone(wa.quality);
                    return (
                      <TR key={entry.accountId}>
                        <TD className="max-w-[12rem]">
                          <Link
                            href={`/clients/${entry.accountId}/channels`}
                            className="text-ink-2 block truncate underline-offset-2 hover:underline"
                          >
                            {entry.name}
                          </Link>
                        </TD>
                        <TD className="text-muted font-mono text-xs">
                          {wa.phoneNumberId}
                        </TD>
                        <TD className="text-ink-2">
                          {wa.tier?.replace(/^TIER_/, '') ?? '—'}
                        </TD>
                        <TD>
                          <Pill tone={q.tone} glyph={q.glyph}>
                            {wa.quality ?? 'Not rated'}
                          </Pill>
                        </TD>
                        <TD align="right">
                          <span className="inline-flex flex-col items-end gap-0.5">
                            <span className="text-muted text-xs">
                              {wa.limitsSyncedAt
                                ? formatAgo(wa.limitsSyncedAt)
                                : 'never'}
                            </span>
                            {stale ? (
                              <Pill tone="info" glyph="?">
                                Stale
                              </Pill>
                            ) : null}
                          </span>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Top Meta error codes · last 7 days"
            description="Across every client, from the failure reason Meta returned on each failed message."
          />
          {errors.rows.length === 0 ? (
            <EmptyState>
              {errors.failedTotal === 0
                ? 'No message failed in the last 7 days.'
                : `${formatNumber(errors.failedTotal)} messages failed, none with a Meta error code recorded.`}
            </EmptyState>
          ) : (
            <>
              <TableWrap>
                <Table minWidth="40rem">
                  <THead>
                    <tr>
                      <TH>Code</TH>
                      <TH>Meta’s reason</TH>
                      <TH align="right">Failures</TH>
                      <TH>Clients</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {errors.rows.map((row) => (
                      <TR key={row.code}>
                        <TD className="text-ink font-mono text-xs font-semibold">
                          {row.code}
                        </TD>
                        <TD className="text-ink-2 max-w-[18rem] text-xs leading-relaxed">
                          {row.title ?? '—'}
                          <span className="text-muted block">
                            last {formatAgo(row.lastSeen)}
                          </span>
                        </TD>
                        <TD
                          align="right"
                          className="text-ink tabular font-semibold"
                        >
                          {formatNumber(row.failures)}
                        </TD>
                        <TD
                          className="text-muted max-w-[12rem] truncate text-xs"
                          title={row.workspaceNames}
                        >
                          {row.workspaces === 1
                            ? row.workspaceNames
                            : `${row.workspaces} clients`}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
              <div className="px-5 pb-4">
                <DerivedNote>
                  {formatNumber(errors.failedTotal)} failed messages in 7 days
                  {errors.withoutCode > 0
                    ? `; ${formatNumber(errors.withoutCode)} carry no Meta error code (failed before reaching Meta, or sent before reasons were kept).`
                    : '; every one carries a Meta error code.'}{' '}
                  Window is the last 7 × 24 hours.
                </DerivedNote>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
