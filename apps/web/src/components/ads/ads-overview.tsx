'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  MousePointerClick,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Target,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/dashboard/metric-card';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import {
  adTypeLabel,
  formatCount,
  formatMinor,
  formatPercent,
  isDelivering,
  resultLabel,
  statusLabel,
  type AdsAdRow,
  type AdsCampaignRow,
  type AdsOverview as AdsOverviewData,
  type AdsSetupStatus,
} from '@/lib/ads/types';
import { AdsTrendChart } from './ads-trend-chart';

/** Preset windows, in days. `custom` is not offered yet — the presets cover the job. */
const RANGES = [7, 30, 90] as const;
type RangeDays = (typeof RANGES)[number];

/**
 * Ads Manager → Overview.
 *
 * Spend, results and per-campaign performance, read entirely from the
 * local mirror (`meta_ads_insights`) rather than from Meta. That is what
 * makes changing the date range instant and keeps a page load from
 * consuming the ad account's shared Marketing API rate limit.
 *
 * WHAT MAKES THIS WORTH BUILDING RATHER THAN LINKING TO META
 *   Meta's own Ads Manager reports spend and conversations. It cannot
 *   report which of those conversations became a deal, because it has
 *   never seen this CRM's pipeline. The per-campaign rows here are the
 *   join Meta cannot do.
 *
 * ⚠️ Every money value arriving from the API is MINOR UNITS. `formatMinor`
 * is the only thing that divides by 100, and it uses the ad account's own
 * currency — not a workspace setting and not the browser's guess.
 */
export function AdsOverview() {
  const canEdit = useCan('edit-settings');

  const [setup, setSetup] = useState<AdsSetupStatus | null>(null);
  const [range, setRange] = useState<RangeDays>(7);
  const [data, setData] = useState<AdsOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Per-range cache, so flipping between 7 / 30 / 90 does not re-fetch a
  // window already on screen once. Same idea as the dashboard's
  // conversations chart.
  const [cache, setCache] = useState<
    Partial<Record<RangeDays, AdsOverviewData>>
  >({});

  const load = useCallback(
    async (days: RangeDays, options: { force?: boolean } = {}) => {
      if (!options.force && cache[days]) {
        setData(cache[days]!);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const until = new Date();
        const since = new Date(until);
        since.setUTCDate(since.getUTCDate() - (days - 1));

        const params = new URLSearchParams({
          since: since.toISOString().slice(0, 10),
          until: until.toISOString().slice(0, 10),
        });

        const res = await fetch(`/api/ads/overview?${params}`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error('Request failed');
        const json = (await res.json()) as AdsOverviewData;
        setData(json);
        setCache((prev) => ({ ...prev, [days]: json }));
      } catch {
        toast.error('Could not load ad performance.');
      } finally {
        setLoading(false);
      }
    },
    [cache],
  );

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/ads/status', { cache: 'no-store' });
        if (res.ok) setSetup((await res.json()) as AdsSetupStatus);
      } catch {
        // The overview is still useful without the setup banner.
      }
    })();
  }, []);

  useEffect(() => {
    void load(range);
  }, [range, load]);

  async function sync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/ads/sync', { method: 'POST' });
      if (!res.ok) throw new Error('Request failed');
      toast.success(
        'Refresh queued. Meta’s numbers take a moment to arrive — this page will show them on the next load.',
      );
    } catch {
      toast.error('Could not queue a refresh.');
    } finally {
      setSyncing(false);
    }
  }

  async function setStatus(
    kind: 'campaigns' | 'ads',
    id: string,
    status: 'ACTIVE' | 'PAUSED',
  ) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/ads/${kind}/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string | string[];
        } | null;
        const message = Array.isArray(body?.message)
          ? body.message.join(', ')
          : body?.message;
        throw new Error(message ?? 'Meta rejected the change.');
      }
      toast.success(status === 'ACTIVE' ? 'Resumed.' : 'Paused.');
      // Force, not cache: the row's status just changed.
      await load(range, { force: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusyId(null);
    }
  }

  const spendSeries = useMemo(
    () =>
      (data?.timeseries ?? []).map((p) => ({ date: p.date, value: p.spend })),
    [data],
  );
  const resultSeries = useMemo(
    () =>
      (data?.timeseries ?? []).map((p) => ({ date: p.date, value: p.results })),
    [data],
  );

  const currency = data?.currency ?? null;
  const money = useCallback(
    (minor: number | null | undefined) => formatMinor(minor, currency),
    [currency],
  );

  // Not connected yet → the Overview has nothing to say, so send them
  // where they can act instead of showing six empty tiles.
  if (setup && !setup.canPublish && (data?.campaigns.length ?? 0) === 0) {
    return <NotReady status={setup} />;
  }

  const totals = data?.totals;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Ads Manager
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data?.lastSyncedAt ? (
              <>
                Meta data last synced{' '}
                {new Date(data.lastSyncedAt).toLocaleString()}.
              </>
            ) : (
              'Not synced from Meta yet.'
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Filters in one row above the charts. */}
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {RANGES.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setRange(days)}
                aria-pressed={range === days}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  range === days
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {days} days
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => void sync()}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refresh
          </Button>

          {/* `nativeButton={false}` on every Button that renders a <Link>:
              Base UI defaults it to true and warns that native button
              semantics were dropped. Navigating is a link's job, so an
              anchor is the correct element — same as the Instagram post
              panel does for its external link. */}
          <Button
            size="sm"
            nativeButton={false}
            render={<Link href="/ads/create" />}
          >
            <Plus className="size-3.5" />
            Create Ad
          </Button>
        </div>
      </header>

      {setup?.sandbox ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-accent-amber">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            Sandbox mode — these campaigns and figures are fixtures, not a real
            ad account.
          </p>
        </div>
      ) : null}

      {/* KPI row. Pre-formatted strings, because MetricCard takes display
          values and money formatting depends on the ad account currency. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Spend"
          value={money(totals?.spend)}
          icon={Wallet}
          subtitle={`${range} days`}
        />
        <MetricCard
          title="Results"
          value={formatCount(totals?.results)}
          icon={Target}
          subtitle="Conversations, leads and conversions"
        />
        <MetricCard
          title="Impressions"
          value={formatCount(totals?.impressions)}
          icon={Eye}
          subtitle={`CTR ${formatPercent(totals?.ctr)}`}
        />
        <MetricCard
          title="Cost per result"
          value={money(totals?.costPerResult)}
          icon={MousePointerClick}
          subtitle={`CPC ${money(totals?.cpc)}`}
        />
      </div>

      {/* Two charts, not one with two y-axes. Spend is money and results
          are a count; a shared axis would make their crossing point an
          artefact of scaling rather than a fact about the data. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <AdsTrendChart
          title="Spend"
          subtitle={`Daily, in ${currency ?? 'your ad account currency'}`}
          points={spendSeries}
          formatValue={money}
          colorVar="--chart-1"
          loading={loading}
        />
        <AdsTrendChart
          title="Results"
          subtitle="Daily conversations, leads and conversions"
          points={resultSeries}
          formatValue={(v) => formatCount(v)}
          colorVar="--chart-2"
          loading={loading}
        />
      </div>

      <CampaignTable
        campaigns={data?.campaigns ?? []}
        currency={currency}
        loading={loading}
        range={range}
        canEdit={canEdit}
        busyId={busyId}
        onSetStatus={setStatus}
      />
    </div>
  );
}

// ============================================================
// Campaign table
// ============================================================

function CampaignTable({
  campaigns,
  currency,
  loading,
  range,
  canEdit,
  busyId,
  onSetStatus,
}: {
  campaigns: AdsCampaignRow[];
  currency: string | null;
  loading: boolean;
  range: number;
  canEdit: boolean;
  busyId: string | null;
  onSetStatus: (
    kind: 'campaigns' | 'ads',
    id: string,
    status: 'ACTIVE' | 'PAUSED',
  ) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Campaigns</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Last {range} days. Status is what Meta reports, not what we asked
          for — an ad can be paused, in review or rejected beneath an active
          campaign.
        </p>
      </header>

      {loading && campaigns.length === 0 ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/40" />
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <div className="p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No campaigns yet. Once you publish one it appears here with its
            spend and results.
          </p>
          <Button
            size="sm"
            className="mt-4"
            nativeButton={false}
            render={<Link href="/ads/create" />}
          >
            <Plus className="size-3.5" />
            Create your first ad
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Budget/day</th>
                <th className="px-3 py-2 text-right font-medium">Spend</th>
                <th className="px-3 py-2 text-right font-medium">Results</th>
                <th className="px-3 py-2 text-right font-medium">Cost/result</th>
                <th className="px-3 py-2 text-right font-medium">CTR</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <CampaignRow
                  key={campaign.id}
                  campaign={campaign}
                  currency={currency}
                  range={range}
                  canEdit={canEdit}
                  busy={busyId === campaign.id}
                  busyId={busyId}
                  expanded={expanded === campaign.id}
                  onToggle={() =>
                    setExpanded((prev) =>
                      prev === campaign.id ? null : campaign.id,
                    )
                  }
                  onSetStatus={onSetStatus}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CampaignRow({
  campaign,
  currency,
  range,
  canEdit,
  busy,
  busyId,
  expanded,
  onToggle,
  onSetStatus,
}: {
  campaign: AdsCampaignRow;
  currency: string | null;
  range: number;
  canEdit: boolean;
  busy: boolean;
  busyId: string | null;
  expanded: boolean;
  onToggle: () => void;
  onSetStatus: (
    kind: 'campaigns' | 'ads',
    id: string,
    status: 'ACTIVE' | 'PAUSED',
  ) => Promise<void>;
}) {
  const [ads, setAds] = useState<AdsAdRow[] | null>(null);
  const [loadingAds, setLoadingAds] = useState(false);

  const money = (minor: number | null | undefined) =>
    formatMinor(minor, currency);
  const live = isDelivering(campaign.effectiveStatus);

  // Ads are fetched on first expand, not with the table: loading every
  // campaign's ads up front is most of the data for none of the screen.
  async function expand() {
    onToggle();
    if (ads !== null || expanded) return;

    setLoadingAds(true);
    try {
      const until = new Date();
      const since = new Date(until);
      since.setUTCDate(since.getUTCDate() - (range - 1));
      const params = new URLSearchParams({
        since: since.toISOString().slice(0, 10),
        until: until.toISOString().slice(0, 10),
      });

      const res = await fetch(
        `/api/ads/campaigns/${campaign.id}/ads?${params}`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error('Request failed');
      const json = (await res.json()) as { ads: AdsAdRow[] };
      setAds(json.ads);
    } catch {
      toast.error('Could not load the ads in this campaign.');
      setAds([]);
    } finally {
      setLoadingAds(false);
    }
  }

  return (
    <>
      <tr className="border-b border-border/60 last:border-0 hover:bg-muted/30">
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={() => void expand()}
            className="flex items-start gap-2 text-left"
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="block truncate font-medium text-foreground">
                {campaign.name}
              </span>
              <span className="block text-xs text-muted-foreground">
                {adTypeLabel(campaign.adType)} · {campaign.adCount}{' '}
                {campaign.adCount === 1 ? 'ad' : 'ads'}
              </span>
            </span>
          </button>
        </td>

        <td className="px-3 py-3">
          <StatusBadge
            effectiveStatus={campaign.effectiveStatus}
            status={campaign.status}
          />
        </td>

        <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
          {campaign.dailyBudget !== null
            ? money(campaign.dailyBudget)
            : campaign.lifetimeBudget !== null
              ? `${money(campaign.lifetimeBudget)} total`
              : '—'}
        </td>
        <td className="px-3 py-3 text-right font-medium tabular-nums text-foreground">
          {money(campaign.totals.spend)}
        </td>
        <td className="px-3 py-3 text-right tabular-nums text-foreground">
          {formatCount(campaign.totals.results)}
          <span className="ml-1 text-xs text-muted-foreground">
            {resultLabel(campaign.adType).toLowerCase()}
          </span>
        </td>
        <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
          {money(campaign.totals.costPerResult)}
        </td>
        <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
          {formatPercent(campaign.totals.ctr)}
        </td>

        <td className="px-4 py-3 text-right">
          {canEdit ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void onSetStatus(
                  'campaigns',
                  campaign.id,
                  live ? 'PAUSED' : 'ACTIVE',
                )
              }
              title={live ? 'Pause this campaign' : 'Resume this campaign'}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : live ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
            </Button>
          ) : null}
        </td>
      </tr>

      {expanded ? (
        <tr className="border-b border-border/60 bg-muted/20">
          <td colSpan={8} className="px-4 py-3">
            {loadingAds ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading ads…
              </div>
            ) : (ads?.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">
                No ads in this campaign.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {ads!.map((ad) => (
                  <li
                    key={ad.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">
                        {ad.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {ad.adsetName}
                      </p>
                    </div>
                    <div className="flex items-center gap-4 text-xs tabular-nums">
                      <StatusBadge
                        effectiveStatus={ad.effectiveStatus}
                        status={ad.status}
                      />
                      <span className="text-muted-foreground">
                        {money(ad.totals.spend)}
                      </span>
                      <span className="text-foreground">
                        {formatCount(ad.totals.results)}{' '}
                        {resultLabel(campaign.adType).toLowerCase()}
                      </span>
                      {canEdit ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === ad.id}
                          onClick={() =>
                            void onSetStatus(
                              'ads',
                              ad.id,
                              isDelivering(ad.effectiveStatus)
                                ? 'PAUSED'
                                : 'ACTIVE',
                            )
                          }
                        >
                          {busyId === ad.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : isDelivering(ad.effectiveStatus) ? (
                            <Pause className="size-3.5" />
                          ) : (
                            <Play className="size-3.5" />
                          )}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Status as a dot + words, never colour alone.
 *
 * The distinction that matters: green means Meta says it is delivering.
 * "Active but not delivering" (an ad in review, a paused ad set, a
 * rejected creative) is the state users misread most, so it gets amber
 * and its own words rather than being lumped in with paused.
 */
function StatusBadge({
  effectiveStatus,
  status,
}: {
  effectiveStatus: string | null;
  status: string | null;
}) {
  const value = effectiveStatus ?? status;
  const tone = isDelivering(effectiveStatus)
    ? 'bg-green-500'
    : value === 'DISAPPROVED' || value === 'WITH_ISSUES'
      ? 'bg-red-500'
      : value === 'IN_PROCESS' || value === 'PENDING_REVIEW'
        ? 'bg-amber-500'
        : 'bg-muted-foreground/50';

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <span className={cn('size-1.5 rounded-full', tone)} />
      {statusLabel(effectiveStatus, status)}
    </span>
  );
}

/** Shown instead of empty tiles when the account cannot run ads yet. */
function NotReady({ status }: { status: AdsSetupStatus }) {
  const blocked = status.steps.filter((s) => !s.done);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
          <Target className="size-5" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-foreground">
          Connect your Meta ad account
        </h1>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          Run Facebook and Instagram ads that land in WhatsApp, and see which
          ones turned into conversations and deals. Ads run on your own ad
          account — Meta bills you directly.
        </p>

        {blocked.length > 0 ? (
          <ul className="mx-auto mt-5 max-w-sm space-y-1.5 text-left text-sm text-muted-foreground">
            {blocked.map((step) => (
              <li key={step.id} className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                {step.label}
              </li>
            ))}
          </ul>
        ) : null}

        <Button
          className="mt-6"
          nativeButton={false}
          render={<Link href="/ads/setup" />}
        >
          Go to setup
        </Button>
      </div>
    </div>
  );
}
