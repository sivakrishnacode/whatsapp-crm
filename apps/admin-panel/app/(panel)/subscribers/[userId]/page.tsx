import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { QuickActions } from '@/components/subscriber/quick-actions';
import { SubscriptionForm } from '@/components/subscriber/subscription-form';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { Meter, StatTile } from '@/components/ui/stat';
import { requireAdmin } from '@/lib/auth';
import { toDateInput } from '@/lib/actions/parse';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelativeDays,
} from '@/lib/format';
import { getSubscriber, planOptions } from '@/lib/queries/subscribers';

export const metadata: Metadata = { title: 'Subscriber · Converse360 Admin' };

export default async function SubscriberDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  await requireAdmin();
  const { userId } = await params;

  const [detail, plans] = await Promise.all([
    getSubscriber(userId),
    planOptions(),
  ]);

  if (!detail) notFound();

  const { subscriber, limits, usage, activity, assignedByEmail } = detail;
  const gateway = subscriber.stripeSubscriptionId
    ? ('stripe' as const)
    : subscriber.razorpaySubscriptionId
      ? ('razorpay' as const)
      : null;

  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/subscribers"
          className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
        >
          ← All subscribers
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-ink truncate text-xl font-semibold">
              {subscriber.fullName || subscriber.email || 'Unnamed user'}
            </h1>
            <p className="text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {subscriber.email ? <span>{subscriber.email}</span> : null}
              {subscriber.accountName ? (
                <span>Account: {subscriber.accountName}</span>
              ) : (
                <span>No account profile</span>
              )}
              {subscriber.accountRole ? (
                <Badge tone="outline">{subscriber.accountRole}</Badge>
              ) : null}
            </p>
          </div>

          <div className="text-right">
            <p className="text-ink text-2xl font-semibold">
              {formatMoney(subscriber.mrr)}
              <span className="text-muted ml-1 text-sm font-normal">/mo</span>
            </p>
            <p className="mt-1 flex items-center justify-end gap-2">
              <StatusBadge status={subscriber.status} />
            </p>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Billed per cycle"
          value={formatMoney(subscriber.periodAmount)}
          context={subscriber.billingCycle ?? 'no billing cycle set'}
        />
        <StatTile
          label="Renews"
          value={formatDate(subscriber.periodEnd)}
          context={
            subscriber.periodEnd
              ? formatRelativeDays(subscriber.periodEnd)
              : 'no period end recorded'
          }
          tone={
            subscriber.periodEnd && subscriber.periodEnd < new Date()
              ? 'warning'
              : 'neutral'
          }
        />
        <StatTile
          label="Subscribed"
          value={formatDate(subscriber.subscribedAt)}
          context={`last changed ${formatDate(subscriber.updatedAt)}`}
        />
        <StatTile
          label="Last sign-in"
          value={formatDate(subscriber.lastSignInAt)}
          context={
            subscriber.lastSignInAt
              ? formatRelativeDays(subscriber.lastSignInAt)
              : 'never signed in'
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Subscription"
              description="The billing record for this user. Saving writes straight to the database the CRM reads."
            />
            <CardBody>
              <SubscriptionForm
                userId={subscriber.userId}
                planId={subscriber.planId}
                status={subscriber.status}
                billingCycle={subscriber.billingCycle}
                paymentMethod={subscriber.paymentMethod}
                periodStart={toDateInput(subscriber.periodStart)}
                periodEnd={toDateInput(subscriber.periodEnd)}
                trialEndAt={toDateInput(subscriber.trialEndAt)}
                cancelAtPeriodEnd={Boolean(subscriber.cancelAtPeriodEnd)}
                gateway={gateway}
                plans={plans.map((plan) => ({
                  id: plan.id,
                  displayName: plan.displayName,
                  priceLabel: `${formatMoney(plan.priceMonthly)}/mo · ${formatMoney(plan.priceYearly)}/yr`,
                }))}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Quick actions"
              description="The changes that come up often, without editing every field."
            />
            <CardBody>
              <QuickActions
                userId={subscriber.userId}
                cancelAtPeriodEnd={Boolean(subscriber.cancelAtPeriodEnd)}
                hasGateway={gateway !== null}
                trialDays={limits?.trialDays ?? null}
              />
            </CardBody>
          </Card>

          {activity ? (
            <Card>
              <CardHeader
                title="Account activity"
                description="Counted from the CRM's own tables — the ground truth for whether this account is in real use."
              />
              <CardBody>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                  {[
                    { label: 'Contacts', value: activity.contacts },
                    { label: 'Conversations', value: activity.conversations },
                    { label: 'Messages', value: activity.messages },
                    { label: 'Broadcasts', value: activity.broadcasts },
                    { label: 'Automations', value: activity.automations },
                    { label: 'Flows', value: activity.flows },
                    { label: 'Team members', value: activity.teamMembers },
                  ].map((item) => (
                    <div key={item.label}>
                      <p className="text-muted text-xs">{item.label}</p>
                      <p className="text-ink tabular mt-0.5 font-medium">
                        {formatNumber(item.value)}
                      </p>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Plan & billing record" />
            <CardBody>
              <Facts
                items={[
                  { label: 'Plan', value: subscriber.planDisplayName },
                  {
                    label: 'Billing cycle',
                    value: subscriber.billingCycle ?? 'None',
                  },
                  {
                    label: 'Payment method',
                    value: subscriber.paymentMethod ?? 'Unrecorded',
                  },
                  {
                    label: 'Gateway subscription',
                    value: gateway ? `Linked (${gateway})` : 'None',
                    hint: gateway
                      ? (subscriber.stripeSubscriptionId ??
                        subscriber.razorpaySubscriptionId)
                      : 'Changes here are the only thing billing this user',
                  },
                  {
                    label: 'Current period',
                    value: `${formatDate(subscriber.periodStart)} → ${formatDate(subscriber.periodEnd)}`,
                  },
                  {
                    label: 'Trial ends',
                    value: formatDate(subscriber.trialEndAt),
                    hint: subscriber.trialEndAt
                      ? formatRelativeDays(subscriber.trialEndAt)
                      : undefined,
                  },
                  {
                    label: 'Cancels at period end',
                    value: subscriber.cancelAtPeriodEnd ? 'Yes' : 'No',
                  },
                  {
                    label: 'Last manual assignment by',
                    value: assignedByEmail ?? 'Not recorded',
                  },
                ]}
              />
              {gateway ? null : (
                <DerivedNote>
                  No gateway subscription is attached, so nothing charges this
                  user automatically. The dates above are a record, not a
                  schedule.
                </DerivedNote>
              )}
            </CardBody>
          </Card>

          {limits ? (
            <Card>
              <CardHeader
                title="Usage against plan limits"
                description={
                  usage
                    ? `Tracked period ${formatDate(usage.periodStart)} → ${formatDate(usage.periodEnd)}.`
                    : 'No usage has been tracked for this user yet.'
                }
              />
              <CardBody className="space-y-3.5">
                <Meter
                  label="Contacts"
                  used={usage?.contactsCount ?? 0}
                  limit={limits.maxContacts}
                  format={formatNumber}
                />
                <Meter
                  label="Messages this period"
                  used={usage?.messagesSent ?? 0}
                  limit={limits.maxMessagesMonthly}
                  format={formatNumber}
                />
                <Meter
                  label="Broadcasts this period"
                  used={usage?.broadcastsSent ?? 0}
                  limit={limits.maxBroadcastsMonthly}
                  format={formatNumber}
                />
                <Meter
                  label="Active flows"
                  used={usage?.flowsActive ?? 0}
                  limit={limits.maxFlows}
                  format={formatNumber}
                />
                <Meter
                  label="Team members"
                  used={activity?.teamMembers ?? 0}
                  limit={limits.maxTeamMembers}
                  format={formatNumber}
                />
                <Meter
                  label="Storage (MB)"
                  used={usage?.storageUsedMb ?? 0}
                  limit={limits.maxStorageMb}
                  format={formatNumber}
                />
                <DerivedNote>
                  These counters are maintained by the api as it works. They can
                  drift from the account activity counted above; the CRM
                  enforces limits against these.
                </DerivedNote>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="User record" />
            <CardBody>
              <Facts
                items={[
                  { label: 'User id', value: subscriber.userId },
                  {
                    label: 'Signed up',
                    value: formatDateTime(subscriber.userCreatedAt),
                  },
                  {
                    label: 'Last sign-in',
                    value: formatDateTime(subscriber.lastSignInAt),
                  },
                  {
                    label: 'Account role',
                    value: subscriber.accountRole ?? 'No profile',
                  },
                  {
                    label: 'Account id',
                    value: subscriber.accountId ?? 'None',
                  },
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
