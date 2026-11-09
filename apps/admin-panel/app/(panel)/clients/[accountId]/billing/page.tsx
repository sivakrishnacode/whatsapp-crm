import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { StatusBadge, Badge } from '@/components/ui/badge';
import {
  Card,
  CardBody,
  CardHeader,
  DerivedNote,
  EmptyState,
} from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { ButtonLink, Callout } from '@/components/ui/page';
import { Meter, StatRow, StatTile } from '@/components/ui/stat';
import { can, requireCapability } from '@/lib/auth';
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatRelativeDays,
} from '@/lib/format';
import { isUuid } from '@/lib/ids';
import { prisma } from '@/lib/prisma';
import { getRosterEntry } from '@/lib/queries/roster';
import { listEnquiries, listMembers } from '@/lib/queries/workspaces';

export const metadata: Metadata = { title: 'Billing · Customer 360' };

/**
 * Subscription, entitlements and usage against limits (C360-029). Plan and
 * status are read from user_subscriptions (keyed by the workspace OWNER),
 * limits from subscription_plans, usage from the same sources
 * check_account_limit counts — never computed client-side.
 *
 * ⚠️ There is no invoices table. Amounts are plan price × cycle, exact for
 * today and silent about history; the note below says so.
 */
export default async function ClientBillingPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const staff = await requireCapability('billing.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();

  const client = await getRosterEntry(accountId);
  if (!client) notFound();

  const [sub, enquiries, members, usage] = await Promise.all([
    prisma.$queryRaw<
      {
        planName: string;
        displayName: string;
        priceMonthly: number;
        priceYearly: number;
        maxContacts: number;
        maxMessages: number;
        maxBroadcasts: number;
        maxTeam: number;
        maxFlows: number | null;
        maxAgents: number | null;
        status: string;
        billingCycle: string | null;
        paymentMethod: string | null;
        periodStart: Date | null;
        periodEnd: Date | null;
        trialStart: Date | null;
        trialEnd: Date | null;
        cancelAtPeriodEnd: boolean | null;
        hasGateway: boolean;
        createdAt: Date | null;
        trialGrantedAt: Date | null;
      }[]
    >`
      select pl.name as "planName", pl.display_name as "displayName",
        coalesce(pl.price_monthly,0)::float8 as "priceMonthly", coalesce(pl.price_yearly,0)::float8 as "priceYearly",
        pl.max_contacts as "maxContacts", pl.max_messages_monthly as "maxMessages",
        pl.max_broadcasts_monthly as "maxBroadcasts", pl.max_team_members as "maxTeam",
        pl.max_flows as "maxFlows", pl.max_ai_agents as "maxAgents",
        s.status, s.billing_cycle as "billingCycle", s.payment_method as "paymentMethod",
        s.current_period_start as "periodStart", s.current_period_end as "periodEnd",
        s.trial_start_at as "trialStart", s.trial_end_at as "trialEnd",
        s.cancel_at_period_end as "cancelAtPeriodEnd",
        (s.stripe_subscription_id is not null or s.razorpay_subscription_id is not null) as "hasGateway",
        s.created_at as "createdAt", ob.trial_granted_at as "trialGrantedAt"
      from accounts a
      join user_subscriptions s on s.user_id = a.owner_user_id
      join subscription_plans pl on pl.id = s.plan_id
      left join account_onboarding ob on ob.account_id = a.id
      where a.id = ${accountId}::uuid
    `,
    listEnquiries(accountId),
    listMembers(accountId),
    prisma.$queryRaw<
      {
        contacts: number;
        flows: number;
        agents: number;
        messages: number;
        broadcasts: number;
      }[]
    >`
      select
        (select count(*) from contacts where account_id = ${accountId}::uuid)::int as "contacts",
        (select count(*) from flows where account_id = ${accountId}::uuid)::int as "flows",
        (select count(*) from ai_agents where account_id = ${accountId}::uuid)::int as "agents",
        coalesce((select messages_sent from account_usage_monthly
          where account_id = ${accountId}::uuid and period_start = date_trunc('month', now())::date), 0)::int as "messages",
        coalesce((select broadcasts_sent from account_usage_monthly
          where account_id = ${accountId}::uuid and period_start = date_trunc('month', now())::date), 0)::int as "broadcasts"
    `,
  ]);

  const s = sub[0];
  const u = usage[0]!;
  const duplicateBilling = members.filter(
    (m) => !m.isAccountOwner && m.ownSubscriptionStatus !== null
  );
  const periodAmount = s
    ? s.billingCycle === 'yearly'
      ? s.priceYearly
      : s.priceMonthly
    : 0;

  return (
    <div className="space-y-6">
      <StatRow>
        <StatTile
          label="MRR"
          value={formatMoney(client.mrr)}
          context="active subscriptions only"
        />
        <StatTile
          label="Per billing period"
          value={s ? formatMoney(periodAmount) : '—'}
          context={
            s
              ? `${s.billingCycle ?? 'monthly'} · ${s.paymentMethod ?? 'no method'}`
              : undefined
          }
        />
        <StatTile
          label="Renews"
          value={s?.periodEnd ? formatDate(s.periodEnd) : '—'}
          context={s?.periodEnd ? formatRelativeDays(s.periodEnd) : undefined}
          tone={s?.cancelAtPeriodEnd ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Trial"
          value={s?.trialEnd ? formatDate(s.trialEnd) : 'None'}
          context={
            s?.trialGrantedAt
              ? `granted ${formatDate(s.trialGrantedAt)} — one per workspace`
              : 'never granted'
          }
        />
      </StatRow>

      {duplicateBilling.length > 0 ? (
        <Callout tone="warn" title="Another member is paying for a plan">
          Only the owner&apos;s subscription is this workspace&apos;s plan.{' '}
          {duplicateBilling
            .map(
              (m) =>
                `${m.fullName || m.email} (${m.ownSubscriptionPlan}, ${m.ownSubscriptionStatus})`
            )
            .join(', ')}
          .
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Subscription"
            action={
              can(staff, 'billing.manage') ? (
                <ButtonLink
                  href={`/subscriptions/${client.ownerUserId}`}
                  size="sm"
                  variant="primary"
                >
                  Edit subscription
                </ButtonLink>
              ) : null
            }
          />
          <CardBody>
            {s ? (
              <Facts
                items={[
                  { label: 'Plan', value: s.displayName, hint: s.planName },
                  {
                    label: 'Status',
                    value: <StatusBadge status={s.status as never} />,
                  },
                  {
                    label: 'Period',
                    value: `${formatDate(s.periodStart)} → ${formatDate(s.periodEnd)}`,
                  },
                  {
                    label: 'Gateway subscription',
                    value: s.hasGateway ? 'Attached' : 'None',
                    hint: s.hasGateway
                      ? undefined
                      : 'a renewal will not bill itself',
                  },
                  {
                    label: 'Cancels at period end',
                    value: s.cancelAtPeriodEnd ? 'Yes' : 'No',
                  },
                  {
                    label: 'Billed to',
                    value: client.ownerEmail ?? client.ownerUserId,
                    hint: 'the owner — subscriptions are keyed by user',
                  },
                  { label: 'Subscribed since', value: formatDate(s.createdAt) },
                ]}
              />
            ) : (
              <p className="text-muted text-sm">
                No subscription. The owner has not chosen a plan in the welcome
                wizard yet.
              </p>
            )}
            <DerivedNote>
              There is no invoices table: amounts are the plan&apos;s current
              price for this cycle. Past invoices and payment history are not
              recorded in this database.
            </DerivedNote>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Usage against plan limits"
            description="Counted the way check_account_limit counts: live for current state, monthly counters for flow."
          />
          <CardBody className="space-y-4">
            {s ? (
              <>
                <Meter
                  label="Contacts"
                  used={u.contacts}
                  limit={s.maxContacts}
                  format={formatNumber}
                />
                <Meter
                  label="Messages this month"
                  used={u.messages}
                  limit={s.maxMessages}
                  format={formatNumber}
                />
                <Meter
                  label="Broadcasts this month"
                  used={u.broadcasts}
                  limit={s.maxBroadcasts}
                  format={formatNumber}
                />
                <Meter
                  label="Team members"
                  used={members.length}
                  limit={s.maxTeam}
                  format={formatNumber}
                />
                <Meter
                  label="Flows"
                  used={u.flows}
                  limit={s.maxFlows}
                  format={formatNumber}
                />
                <Meter
                  label="AI agents"
                  used={u.agents}
                  limit={s.maxAgents}
                  format={formatNumber}
                />
              </>
            ) : (
              <p className="text-muted text-sm">
                No plan, so no limits apply yet.
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Enterprise enquiries"
          description="A negotiated price lives only here — it contributes nothing to MRR."
        />
        {enquiries.length === 0 ? (
          <EmptyState>No enquiries from this workspace.</EmptyState>
        ) : (
          <ul className="divide-line divide-y">
            {enquiries.map((e) => (
              <li key={e.id} className="px-5 py-3 text-sm">
                <p className="text-ink-2">
                  {e.fullName} <Badge tone="outline">{e.status}</Badge>
                </p>
                <p className="text-muted text-xs">
                  {e.workEmail}
                  {e.companySize ? ` · ${e.companySize}` : ''} ·{' '}
                  {formatDate(e.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
