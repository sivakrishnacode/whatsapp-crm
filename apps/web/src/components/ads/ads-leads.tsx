'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { HandCoins, MessageCircle, Users } from 'lucide-react';
import { toast } from 'sonner';

import { MetricCard } from '@/components/dashboard/metric-card';
import { cn } from '@/lib/utils';
import { formatCount, formatMinor } from '@/lib/ads/types';

interface LeadsResponse {
  currency: string | null;
  totals: {
    spend: number;
    leads: number;
    deals: number;
    dealValue: number;
    costPerLead: number | null;
  };
  leads: Array<{
    contactId: string;
    name: string | null;
    phone: string | null;
    source: string;
    createdAt: string;
    campaignName: string | null;
    dealCount: number;
    dealValue: number;
    conversationId: string | null;
  }>;
}

const RANGES = [7, 30, 90] as const;

/**
 * Ads Manager → Leads.
 *
 * The one screen Meta's own Ads Manager cannot produce: spend on one side,
 * the contacts and deals it created on the other. It works only because
 * the insights mirror lives in the same database as `contacts`, `deals`
 * and `ctwa_clicks`.
 *
 * ⚠️ `spend` and `dealValue` are both MINOR units here, but they arrive
 * from different places — spend from Meta, deal value from `deals.value`,
 * which is a DECIMAL in major units and is converted server-side. Both are
 * formatted with the ad account's currency, which is only correct while a
 * workspace has one ad account; that is enforced by
 * `meta_ads_config.account_id` being unique.
 */
export function AdsLeads() {
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<LeadsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    try {
      const until = new Date();
      const since = new Date(until);
      since.setUTCDate(since.getUTCDate() - (days - 1));
      const params = new URLSearchParams({
        since: since.toISOString().slice(0, 10),
        until: until.toISOString().slice(0, 10),
      });

      const res = await fetch(`/api/ads/leads?${params}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Request failed');
      setData((await res.json()) as LeadsResponse);
    } catch {
      toast.error('Could not load ad leads.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [range, load]);

  const currency = data?.currency ?? null;
  const money = (minor: number | null | undefined) =>
    formatMinor(minor, currency);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Leads from ads
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every contact an ad produced, and what it became in your pipeline.
          </p>
        </div>
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
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Leads"
          value={formatCount(data?.totals.leads)}
          icon={Users}
          subtitle={`Last ${range} days`}
        />
        <MetricCard
          title="Cost per lead"
          value={money(data?.totals.costPerLead)}
          icon={HandCoins}
          subtitle={`${money(data?.totals.spend)} spent`}
        />
        <MetricCard
          title="Deals created"
          value={formatCount(data?.totals.deals)}
          icon={MessageCircle}
          subtitle="From these leads"
        />
        <MetricCard
          title="Pipeline value"
          value={money(data?.totals.dealValue)}
          icon={HandCoins}
          subtitle="Open + won deals from ads"
        />
      </div>

      <section className="rounded-xl border border-border bg-card">
        <header className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Leads</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Click-to-WhatsApp conversations and lead-form submissions. A plain
            inbound WhatsApp message is not counted — only contacts an ad click
            can be traced to.
          </p>
        </header>

        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-lg bg-muted/40"
              />
            ))}
          </div>
        ) : (data?.leads.length ?? 0) === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No ad leads in this period yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 text-right font-medium">Deals</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                  <th className="px-4 py-2 font-medium">Arrived</th>
                </tr>
              </thead>
              <tbody>
                {data!.leads.map((lead) => (
                  <tr
                    key={lead.contactId}
                    className="border-b border-border/60 last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/contacts?contact=${lead.contactId}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {lead.name || lead.phone || 'Unnamed contact'}
                      </Link>
                      {lead.name && lead.phone ? (
                        <span className="block text-xs text-muted-foreground">
                          {lead.phone}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {lead.source === 'facebook_lead'
                        ? 'Lead form'
                        : 'Click to WhatsApp'}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {lead.campaignName ?? '—'}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-foreground">
                      {lead.dealCount || '—'}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-foreground">
                      {lead.dealValue ? money(lead.dealValue) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(lead.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
