import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  Card,
  CardBody,
  CardHeader,
  DerivedNote,
  EmptyState,
} from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { Pill } from '@/components/ui/badge';
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
import { formatAgo, formatDate } from '@/lib/format';
import { isUuid } from '@/lib/ids';
import { getClientIntegrations } from '@/lib/queries/clients';
import { requestNow } from '@/lib/clock';

export const metadata: Metadata = { title: 'Integrations · Customer 360' };

/**
 * CRM / API connections for one client. Never a secret: key HASHES are not
 * selected, webhook and store URLs are reduced to their origin (paths and
 * query strings can carry tokens), and the Google bridge's exec URL and
 * secret are not read at all.
 */
export default async function ClientIntegrationsPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  await requireCapability('clients.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();

  const data = await getClientIntegrations(accountId);
  const now = requestNow().getTime();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="API keys"
          description="Public v1 API credentials. Prefix only — the key itself is a hash we cannot reverse."
        />
        {data.apiKeys.length === 0 ? (
          <EmptyState>
            No API keys. Keys are created by the customer in Settings → API.
          </EmptyState>
        ) : (
          <TableWrap>
            <Table minWidth="40rem">
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Prefix</TH>
                  <TH>State</TH>
                  <TH>Created</TH>
                  <TH>Last used</TH>
                  <TH>Expires</TH>
                </tr>
              </THead>
              <TBody>
                {data.apiKeys.map((k) => {
                  const expired = k.expiresAt && k.expiresAt.getTime() < now;
                  return (
                    <TR key={k.id}>
                      <TD className="font-semibold">{k.name}</TD>
                      <TD className="font-mono text-xs">{k.prefix}…</TD>
                      <TD>
                        {k.revokedAt ? (
                          <Pill tone="neutral" glyph="□">
                            Revoked
                          </Pill>
                        ) : expired ? (
                          <Pill tone="bad" glyph="■">
                            Expired
                          </Pill>
                        ) : (
                          <Pill tone="good" glyph="●">
                            Active
                          </Pill>
                        )}
                      </TD>
                      <TD>{formatDate(k.createdAt)}</TD>
                      <TD>
                        {k.lastUsedAt ? formatAgo(k.lastUsedAt) : 'Never'}
                      </TD>
                      <TD>
                        {k.expiresAt ? formatDate(k.expiresAt) : 'No expiry'}
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
        <Card>
          <CardHeader
            title="Webhook endpoints"
            description="Where we deliver signed events. Origin only."
          />
          {data.webhooks.length === 0 ? (
            <EmptyState>No webhook endpoints.</EmptyState>
          ) : (
            <ul className="divide-line divide-y">
              {data.webhooks.map((h) => (
                <li
                  key={h.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-ink truncate font-mono text-xs">
                      {h.origin}
                    </p>
                    <p className="text-muted mt-0.5 text-xs">
                      Added {formatDate(h.createdAt)} · last successful delivery{' '}
                      {h.lastDeliveryAt ? formatAgo(h.lastDeliveryAt) : 'never'}
                    </p>
                  </div>
                  {h.isActive ? (
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
              Failed deliveries are retried by the API&apos;s webhook-delivery
              queue and are not written to the database, so only successes are
              visible here.
            </DerivedNote>
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Google (Apps Script bridge)" />
            <CardBody>
              {data.google ? (
                <Facts
                  items={[
                    {
                      label: 'Connected',
                      value: formatDate(data.google.createdAt),
                    },
                    {
                      label: 'Last successful call',
                      value: data.google.lastOkAt
                        ? formatAgo(data.google.lastOkAt)
                        : 'Never',
                    },
                    {
                      label: 'Last error',
                      value: data.google.lastErrorAt
                        ? formatAgo(data.google.lastErrorAt)
                        : 'None',
                      hint: data.google.lastError ?? undefined,
                    },
                    {
                      label: 'Script version',
                      value: data.google.scriptVersion
                        ? `v${data.google.scriptVersion}`
                        : 'Never reported',
                    },
                  ]}
                />
              ) : (
                <p className="text-muted text-sm">Not connected.</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="E-commerce stores" />
            {data.stores.length === 0 ? (
              <EmptyState>No store connected.</EmptyState>
            ) : (
              <ul className="divide-line divide-y">
                {data.stores.map((s) => (
                  <li key={s.platform} className="px-5 py-3 text-sm">
                    <p className="text-ink font-semibold capitalize">
                      {s.platform}{' '}
                      <span className="text-muted font-mono text-xs font-normal">
                        {s.storeOrigin}
                      </span>
                    </p>
                    <p className="text-muted mt-0.5 text-xs">
                      {s.status} · last sync{' '}
                      {s.lastSyncAt ? formatAgo(s.lastSyncAt) : 'never'}
                      {s.syncError ? ` · error: ${s.syncError}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
