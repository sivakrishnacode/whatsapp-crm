import type { Metadata } from 'next';
import Link from 'next/link';

import { Pill } from '@/components/ui/badge';
import {
  Card,
  CardBody,
  CardHeader,
  DerivedNote,
  EmptyState,
} from '@/components/ui/card';
import { Callout, PageHeader, ScopeLine } from '@/components/ui/page';
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
import { formatAgo, formatDate, formatDateTime } from '@/lib/format';
import { getFleetIntegrations } from '@/lib/queries/integrations';
import { requestNow } from '@/lib/clock';

export const metadata: Metadata = {
  title: 'CRM / API Operations · Converse360 Control Center',
};

const WEEK = 7 * 86_400_000;

function ClientLink({ id, name }: { id: string; name: string }) {
  return (
    <Link
      href={`/clients/${id}/integrations`}
      className="text-ink font-semibold hover:underline"
    >
      {name}
    </Link>
  );
}

/**
 * Every customer's API keys, webhook endpoints, Google bridge and store
 * connections in one place (L3 / Super Admin). No secret is ever loaded —
 * see lib/queries/integrations.ts.
 */
export default async function IntegrationsPage() {
  await requireCapability('integrations.read');
  const { apiKeys, webhooks, google, stores } = await getFleetIntegrations();
  const now = requestNow().getTime();

  const liveKeys = apiKeys.filter(
    (k) => !k.revokedAt && (!k.expiresAt || k.expiresAt.getTime() > now)
  );
  const expiringKeys = liveKeys.filter(
    (k) => k.expiresAt && k.expiresAt.getTime() - now < WEEK
  );
  const usedThisWeek = liveKeys.filter(
    (k) => k.lastUsedAt && now - k.lastUsedAt.getTime() < WEEK
  );
  const activeHooks = webhooks.filter((w) => w.isActive);
  const silentHooks = activeHooks.filter(
    (w) => !w.lastDeliveryAt || now - w.lastDeliveryAt.getTime() > WEEK
  );
  const failingGoogle = google.filter(
    (g) => g.lastErrorAt && (!g.lastOkAt || g.lastErrorAt > g.lastOkAt)
  );
  const failingStores = stores.filter(
    (s) => s.syncError || s.status !== 'connected'
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM / API Operations"
        description="Every customer's public-API credentials, outbound webhooks, Google bridge and store connections — the integration side of support."
      />

      <StatRow columns={5}>
        <StatTile
          label="Live API keys"
          value={String(liveKeys.length)}
          context={`${usedThisWeek.length} used in the last 7 days`}
        />
        <StatTile
          label="Keys expiring ≤ 7 days"
          value={String(expiringKeys.length)}
          tone={expiringKeys.length ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Active webhooks"
          value={String(activeHooks.length)}
          context={`${silentHooks.length} with no success in 7 days`}
          tone={silentHooks.length ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Google bridges failing"
          value={String(failingGoogle.length)}
          tone={failingGoogle.length ? 'warning' : 'neutral'}
          context={`of ${google.length} connected`}
        />
        <StatTile
          label="Stores with sync problems"
          value={String(failingStores.length)}
          tone={failingStores.length ? 'warning' : 'neutral'}
          context={`of ${stores.length} connected`}
        />
      </StatRow>

      <ScopeLine>
        <span>Live from the database, times in {adminTimezone()}</span>
        <span aria-hidden>·</span>
        <span>
          Key hashes, webhook secrets, script URLs and store credentials are
          never read
        </span>
      </ScopeLine>

      <Card>
        <CardHeader
          title="API keys"
          description="Public v1 API credentials across all tenants. Prefix only."
        />
        {apiKeys.length === 0 ? (
          <EmptyState>No customer has created an API key yet.</EmptyState>
        ) : (
          <TableWrap>
            <Table minWidth="54rem">
              <THead>
                <tr>
                  <TH>Client</TH>
                  <TH>Key</TH>
                  <TH>State</TH>
                  <TH>Created</TH>
                  <TH>Last used</TH>
                  <TH>Expires</TH>
                </tr>
              </THead>
              <TBody>
                {apiKeys.map((k) => {
                  const expired = k.expiresAt && k.expiresAt.getTime() < now;
                  const expiring =
                    !expired &&
                    k.expiresAt &&
                    k.expiresAt.getTime() - now < WEEK;
                  return (
                    <TR key={k.id}>
                      <TD>
                        <ClientLink id={k.accountId} name={k.accountName} />
                      </TD>
                      <TD>
                        <p className="text-ink-2">{k.name}</p>
                        <p className="text-muted font-mono text-xs">
                          {k.prefix}…
                        </p>
                      </TD>
                      <TD>
                        {k.revokedAt ? (
                          <Pill tone="neutral" glyph="□">
                            Revoked
                          </Pill>
                        ) : expired ? (
                          <Pill tone="bad" glyph="■">
                            Expired
                          </Pill>
                        ) : expiring ? (
                          <Pill tone="warn" glyph="▲">
                            Expiring
                          </Pill>
                        ) : (
                          <Pill tone="good" glyph="●">
                            Active
                          </Pill>
                        )}
                      </TD>
                      <TD>{formatDate(k.createdAt)}</TD>
                      <TD
                        title={
                          k.lastUsedAt
                            ? formatDateTime(k.lastUsedAt)
                            : undefined
                        }
                      >
                        {k.lastUsedAt ? (
                          formatAgo(k.lastUsedAt)
                        ) : (
                          <span className="text-muted">Never</span>
                        )}
                      </TD>
                      <TD>
                        {k.expiresAt ? (
                          formatDate(k.expiresAt)
                        ) : (
                          <span className="text-muted">No expiry</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader
            title="Webhook endpoints"
            description="Where each customer receives signed events. Origin only."
          />
          {webhooks.length === 0 ? (
            <EmptyState>No webhook endpoints registered.</EmptyState>
          ) : (
            <ul className="divide-line divide-y">
              {webhooks.map((w) => (
                <li
                  key={w.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <ClientLink id={w.accountId} name={w.accountName} />
                    <p className="text-ink-2 truncate font-mono text-xs">
                      {w.origin}
                    </p>
                    <p className="text-muted text-xs">
                      Last successful delivery{' '}
                      {w.lastDeliveryAt ? formatAgo(w.lastDeliveryAt) : 'never'}
                    </p>
                  </div>
                  {w.isActive ? (
                    <Pill tone="good" glyph="●">
                      Active
                    </Pill>
                  ) : (
                    <Pill tone="neutral" glyph="○">
                      Paused
                    </Pill>
                  )}
                </li>
              ))}
            </ul>
          )}
          <CardBody className="pt-0">
            <DerivedNote>
              Only successes are recorded here (`last_delivery_at`). Failed
              attempts, retries and the dead-letter list live in the API&apos;s{' '}
              <code>webhook-delivery</code> queue — see the queue dashboard at
              /admin/queues on the API host, which has its own ops credential.
            </DerivedNote>
          </CardBody>
        </Card>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Google (Apps Script bridge)"
              description="Runs in each customer's own Google account."
            />
            {google.length === 0 ? (
              <EmptyState>No customer has connected Google.</EmptyState>
            ) : (
              <ul className="divide-line divide-y">
                {google.map((g) => {
                  const failing =
                    g.lastErrorAt &&
                    (!g.lastOkAt || g.lastErrorAt > g.lastOkAt);
                  return (
                    <li key={g.accountId} className="px-5 py-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <ClientLink id={g.accountId} name={g.accountName} />
                        {failing ? (
                          <Pill tone="warn" glyph="▲">
                            Failing
                          </Pill>
                        ) : g.lastOkAt ? (
                          <Pill tone="good" glyph="●">
                            Working
                          </Pill>
                        ) : (
                          <Pill tone="info" glyph="?">
                            Never called
                          </Pill>
                        )}
                      </div>
                      <p className="text-muted mt-1 text-xs">
                        Last ok {g.lastOkAt ? formatAgo(g.lastOkAt) : 'never'} ·
                        script{' '}
                        {g.scriptVersion
                          ? `v${g.scriptVersion}`
                          : 'version not reported'}
                        {failing && g.lastError ? ` · ${g.lastError}` : ''}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="E-commerce stores" />
            {stores.length === 0 ? (
              <EmptyState>No stores connected.</EmptyState>
            ) : (
              <ul className="divide-line divide-y">
                {stores.map((s) => (
                  <li
                    key={`${s.accountId}-${s.platform}`}
                    className="px-5 py-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <ClientLink id={s.accountId} name={s.accountName} />
                      {s.syncError || s.status !== 'connected' ? (
                        <Pill tone="warn" glyph="▲">
                          {s.status}
                        </Pill>
                      ) : (
                        <Pill tone="good" glyph="●">
                          Syncing
                        </Pill>
                      )}
                    </div>
                    <p className="text-muted mt-1 text-xs">
                      <span className="capitalize">{s.platform}</span> ·{' '}
                      <span className="font-mono">{s.origin}</span> · last sync{' '}
                      {s.lastSyncAt ? formatAgo(s.lastSyncAt) : 'never'}
                      {s.syncError ? ` · ${s.syncError}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Callout tone="neutral" title="Not in this panel yet">
            Request logs per key, a webhook test console and a sandbox
            (C360-012/013) need the API to record requests and deliveries; today
            it records only last-used and last-success timestamps.
          </Callout>
        </div>
      </div>
    </div>
  );
}
