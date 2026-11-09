import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { InlineAction } from '@/components/clients/inline-action';
import {
  HealthBadge,
  LifecycleBadge,
  SERVICE_TIER_LABEL,
} from '@/components/ops/badges';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/page';
import { RouteTabs } from '@/components/ui/route-tabs';
import { assignToMe } from '@/lib/actions/clients';
import { can, requireCapability } from '@/lib/auth';
import { formatDate, formatMoney } from '@/lib/format';
import { isUuid } from '@/lib/ids';
import { getRosterEntry } from '@/lib/queries/roster';

/**
 * Customer 360 (C360-024). The header is the account at a glance — who it
 * is, who owns it on our side, its stage, its health and its setup progress —
 * and the tabs below are routes, so each one deep-links, survives a refresh
 * and works with back/forward.
 *
 * Every tab page calls `requireCapability` again: a layout check protects the
 * render of the layout, not its children.
 */
export default async function ClientLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ accountId: string }>;
}) {
  const staff = await requireCapability('clients.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();

  const client = await getRosterEntry(accountId);
  if (!client) notFound();

  const base = `/clients/${accountId}`;
  const showMoney = can(staff, 'billing.read');
  const worst = client.health.checks.find(
    (c) => c.state === client.health.overall
  );

  const tabs = [
    { href: base, label: 'Overview', exact: true },
    { href: `${base}/performance`, label: 'Performance' },
    { href: `${base}/channels`, label: 'Channels & health' },
    { href: `${base}/team`, label: 'Team', count: client.members },
    { href: `${base}/ai`, label: 'AI & credits' },
    ...(showMoney ? [{ href: `${base}/billing`, label: 'Billing' }] : []),
    { href: `${base}/integrations`, label: 'Integrations' },
    { href: `${base}/tickets`, label: 'Tickets', count: client.openTickets },
    { href: `${base}/timeline`, label: 'Timeline' },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Link
          href="/clients"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-xs font-medium"
        >
          <span aria-hidden>←</span> All clients
        </Link>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <p className="text-muted text-[11px] font-semibold tracking-wider uppercase">
              Customer 360
            </p>
            <h1 className="text-ink mt-1 truncate text-2xl font-bold tracking-tight">
              {client.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <LifecycleBadge
                stage={client.lifecycle.stage}
                pinned={client.lifecycle.pinned}
                title={client.lifecycle.because}
              />
              <HealthBadge
                state={client.health.overall}
                title={worst ? `${worst.label}: ${worst.evidence}` : undefined}
              />
              {showMoney ? <StatusBadge status={client.subStatus} /> : null}
              <Badge>
                {SERVICE_TIER_LABEL[client.serviceTier] ?? client.serviceTier}
              </Badge>
              {client.tags.map((tag) => (
                <Badge key={tag} tone="outline">
                  {tag}
                </Badge>
              ))}
            </div>
            <dl className="text-muted mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <div>
                <dt className="inline">Tenant </dt>
                <dd className="text-ink-2 inline font-mono">
                  {client.accountId}
                </dd>
              </div>
              <div>
                <dt className="inline">Owner </dt>
                <dd className="text-ink-2 inline">
                  {client.ownerName ? `${client.ownerName} · ` : ''}
                  {client.ownerEmail ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="inline">Account manager </dt>
                <dd className="text-ink-2 inline">
                  {client.managerName ?? 'Unassigned'}
                </dd>
              </div>
              <div>
                <dt className="inline">Created </dt>
                <dd className="text-ink-2 inline">
                  {formatDate(client.createdAt)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="flex flex-col gap-3 lg:items-end">
            <div className="lg:text-right">
              <p className="text-muted text-[11px] font-semibold tracking-wider uppercase">
                Setup completion
              </p>
              <p className="text-ink text-2xl font-bold">
                {client.health.completion.percent}%
              </p>
              {showMoney ? (
                <p className="text-muted text-xs">
                  {client.planDisplayName ?? 'No plan'} ·{' '}
                  {formatMoney(client.mrr)}/mo MRR
                </p>
              ) : (
                <p className="text-muted text-xs">
                  {client.planDisplayName ?? 'No plan'}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2 lg:justify-end">
              {can(staff, 'tickets.work') ? (
                <ButtonLink
                  href={`/support/new?accountId=${accountId}`}
                  variant="primary"
                  size="sm"
                >
                  Open ticket
                </ButtonLink>
              ) : null}
              {can(staff, 'clients.manage') &&
              staff.id &&
              client.managerId !== staff.id ? (
                <InlineAction action={assignToMe} fields={{ accountId }}>
                  Assign to me
                </InlineAction>
              ) : null}
              {can(staff, 'billing.manage') ? (
                <ButtonLink
                  href={`/subscriptions/${client.ownerUserId}`}
                  size="sm"
                >
                  Change plan
                </ButtonLink>
              ) : null}
            </div>
          </div>
        </div>

        <RouteTabs tabs={tabs} label="Customer 360 sections" />
      </div>

      {children}
    </div>
  );
}
