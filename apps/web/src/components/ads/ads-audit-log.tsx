'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ScrollText } from 'lucide-react';

import { cn } from '@/lib/utils';

interface AuditEntry {
  id: string;
  action: string;
  objectType: string | null;
  objectId: string | null;
  succeeded: boolean;
  error: string | null;
  createdAt: string;
  actorName: string | null;
  detail: unknown;
}

/**
 * Plain-words labels for the actions written by `AdsConfigService.audit`.
 *
 * A map rather than prettifying the slug: `publish_ad` → "Published an ad"
 * reads better than "Publish ad", and several actions deserve wording that
 * says what actually happened rather than what the code called it.
 */
const ACTION_LABELS: Record<string, string> = {
  connect: 'Connected a Facebook account',
  connect_sandbox: 'Connected a sandbox account',
  disconnect: 'Disconnected the ad account',
  select_ad_account: 'Selected an ad account',
  select_page: 'Selected a Facebook page',
  select_pixel: 'Selected a pixel',
  link_whatsapp: 'Linked the WhatsApp number',
  accept_lead_terms: 'Recorded the lead-ads terms',
  publish_ad: 'Published an ad',
  pause_campaign: 'Paused a campaign',
  resume_campaign: 'Resumed a campaign',
  pause_ad: 'Paused an ad',
  resume_ad: 'Resumed an ad',
  create_lead_form: 'Created a lead form',
  create_audience_from_contacts: 'Built an audience from contacts',
  create_saved_audience: 'Saved an audience',
  create_lookalike: 'Created a lookalike audience',
  refresh_audience: 'Refreshed an audience',
  data_deletion_request: 'Data deletion requested via Meta',
};

/**
 * The spending trail, on the Setup page.
 *
 * `meta_ads_audit` records every write to Meta including the ones that
 * failed — a rejected publish attempt is exactly what someone asks about
 * when a campaign did not appear. Without a surface it was queryable only
 * by hand, which for an audit log means effectively not readable.
 *
 * Admin-only, matching the RLS on the table and the endpoint's own
 * `@RequireRole('admin')`. A 403 renders nothing rather than an error: a
 * non-admin simply does not see the section.
 */
export function AdsAuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/ads/audit', { cache: 'no-store' });
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) throw new Error('Request failed');
        const json = (await res.json()) as { data: AuditEntry[] };
        setEntries(json.data);
      } catch {
        // A log that will not load is not worth an error toast on a page
        // whose main job is something else.
        setEntries([]);
      }
    })();
  }, []);

  if (forbidden || entries === null || entries.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ScrollText className="size-4 text-muted-foreground" />
          Activity
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Every change made to your Meta ads from here, including attempts
          that failed.
        </p>
      </header>

      <ul className="divide-y divide-border">
        {entries.slice(0, 25).map((entry) => (
          <li key={entry.id} className="flex items-start gap-2.5 px-4 py-2.5">
            <span
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full',
                entry.succeeded
                  ? 'bg-primary-soft text-primary'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {entry.succeeded ? (
                <Check className="size-2.5" />
              ) : (
                <AlertTriangle className="size-2.5" />
              )}
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">
                {ACTION_LABELS[entry.action] ?? entry.action}
                {!entry.succeeded ? (
                  <span className="ml-1.5 text-xs text-destructive">
                    failed
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {/* "system" rather than blank: Meta's deletion callback has
                    no user behind it, and an empty name reads as a bug. */}
                {entry.actorName ?? 'system'} ·{' '}
                {new Date(entry.createdAt).toLocaleString()}
              </p>
              {entry.error ? (
                <p className="mt-0.5 text-xs text-destructive">{entry.error}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
