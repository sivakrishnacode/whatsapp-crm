import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AdjustCredits } from '@/components/credits/adjust-credits';
import { InviteActions } from '@/components/workspace/invite-actions';
import { MemberActions } from '@/components/workspace/member-actions';
import { WorkspaceForm } from '@/components/workspace/workspace-form';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { StatRow, StatTile } from '@/components/ui/stat';
import { requireAdmin } from '@/lib/auth';
import { maxCreditAdjustment } from '@/lib/env';
import {
  formatCredits,
  formatDate,
  formatDateTime,
  formatDelta,
  formatMinor,
  formatMoney,
  formatNumber,
  formatRelativeDays,
  initialsOf,
} from '@/lib/format';
import { auditForAccount } from '@/lib/queries/audit';
import {
  LOW_CREDIT_THRESHOLD,
  getWorkspace,
  type LedgerEntry,
} from '@/lib/queries/workspaces';

export const metadata: Metadata = { title: 'Workspace · Converse360 Admin' };

/**
 * One tenant, end to end: its people, its plan, its AI credits and what it has
 * actually done with the product.
 *
 * The page is deliberately ordered by what an operator came here to do — the
 * membership list and the credit adjustment are above the fold; the read-only
 * facts that explain a support ticket sit in the right column.
 */
export default async function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  await requireAdmin();
  const { accountId } = await params;

  const [detail, audit] = await Promise.all([
    getWorkspace(accountId),
    auditForAccount(accountId),
  ]);

  if (!detail) notFound();

  const {
    workspace,
    members,
    invites,
    wallet,
    ledger,
    orders,
    ai,
    channels,
    activity,
    duplicateBilling,
    enquiries,
  } = detail;

  const balance = wallet?.balance ?? 0;
  const onPlatform = ai?.creditMode === 'platform';
  const creditsTone =
    onPlatform && balance === 0
      ? 'critical'
      : onPlatform && balance <= LOW_CREDIT_THRESHOLD
        ? 'warning'
        : 'neutral';

  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/workspaces"
          className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
        >
          ← All workspaces
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-ink truncate text-xl font-semibold">
              {workspace.accountName}
            </h1>
            <p className="text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span>
                Owner: {workspace.ownerName || workspace.ownerEmail || '—'}
              </span>
              <span>Created {formatDate(workspace.createdAt)}</span>
              {workspace.onboardedAt ? null : (
                <Badge tone="outline">onboarding unfinished</Badge>
              )}
            </p>
          </div>

          <div className="text-right">
            <p className="text-ink text-2xl font-semibold">
              {formatMoney(workspace.mrr)}
              <span className="text-muted ml-1 text-sm font-normal">/mo</span>
            </p>
            <p className="mt-1 flex items-center justify-end gap-2">
              <StatusBadge status={workspace.status} />
            </p>
          </div>
        </div>
      </header>

      <StatRow>
        <StatTile
          label="AI credits"
          value={formatCredits(balance)}
          context={
            ai === null
              ? 'AI has never been set up here'
              : onPlatform
                ? `spending ours · ${formatCredits(workspace.creditsSpent30d)} used in 30 days`
                : 'on their own provider key — credits sit unused'
          }
          tone={creditsTone}
        />
        <StatTile
          label="People"
          value={formatNumber(members.length)}
          context={
            invites.length > 0
              ? `${invites.length} invitation(s) still open`
              : 'no open invitations'
          }
        />
        <StatTile
          label="Conversations"
          value={formatNumber(activity.conversations)}
          context={`${formatNumber(activity.messages)} messages, ${formatNumber(activity.contacts)} contacts`}
        />
        <StatTile
          label="Last message"
          value={formatDate(activity.lastMessageAt)}
          context={
            activity.lastMessageAt
              ? formatRelativeDays(activity.lastMessageAt)
              : 'this workspace has never messaged anyone'
          }
          tone={activity.lastMessageAt ? 'neutral' : 'warning'}
        />
      </StatRow>

      {duplicateBilling.length > 0 ? (
        <Card>
          <CardHeader
            title="More than one subscription in this workspace"
            description="A plan belongs to the workspace, but user_subscriptions is keyed by user — so only the owner's row is the workspace's plan. These members are paying for plans nobody is using."
          />
          <CardBody className="space-y-2">
            {duplicateBilling.map((member) => (
              <p key={member.userId} className="text-ink-2 text-sm">
                <Link
                  href={`/subscribers/${member.userId}`}
                  className="text-ink font-medium underline-offset-2 hover:underline"
                >
                  {member.fullName || member.email}
                </Link>{' '}
                — {member.ownSubscriptionPlan} ({member.ownSubscriptionStatus}),{' '}
                {formatMoney(member.ownSubscriptionMrr)}/mo
              </p>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="People in this workspace"
              description="Removing someone keeps their login and moves them into a workspace of their own — the same thing the CRM's own remove button does."
            />
            <ul className="divide-line divide-y">
              {members.map((member) => (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-start justify-between gap-4 px-5 py-4"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      aria-hidden
                      className="bg-surface-2 text-ink-2 grid size-8 shrink-0 place-items-center rounded-full text-xs font-medium"
                    >
                      {initialsOf(member.fullName, member.email)}
                    </span>
                    <div className="min-w-0">
                      <p className="text-ink flex flex-wrap items-center gap-2 font-medium">
                        <Link
                          href={`/subscribers/${member.userId}`}
                          className="truncate underline-offset-2 hover:underline"
                        >
                          {member.fullName || member.email || 'Unnamed user'}
                        </Link>
                        <Badge>{member.accountRole}</Badge>
                        {member.isAccountOwner ? (
                          <Badge tone="outline">owner of record</Badge>
                        ) : null}
                      </p>
                      <p className="text-muted mt-0.5 truncate text-xs">
                        {member.email}
                      </p>
                      <p className="text-muted mt-1 text-xs">
                        Last sign-in {formatDate(member.lastSignInAt)}
                        {member.emailConfirmedAt
                          ? ''
                          : ' · email not confirmed'}
                        {member.bannedUntil && member.bannedUntil > new Date()
                          ? ` · banned until ${formatDate(member.bannedUntil)}`
                          : ''}
                      </p>
                    </div>
                  </div>

                  <MemberActions
                    accountId={accountId}
                    userId={member.userId}
                    role={member.accountRole}
                    isOwner={member.isAccountOwner}
                    assignedDeals={member.assignedDeals}
                  />
                </li>
              ))}
            </ul>

            {invites.length > 0 ? (
              <div className="border-line border-t">
                <p className="text-ink-2 px-5 pt-4 text-xs font-semibold">
                  Open invitations
                </p>
                <ul className="divide-line divide-y">
                  {invites.map((invite) => (
                    <li
                      key={invite.id}
                      className="flex flex-wrap items-center justify-between gap-4 px-5 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-ink-2 text-sm">
                          {invite.label || 'Unlabelled invitation'}{' '}
                          <Badge>{invite.role}</Badge>
                        </p>
                        <p className="text-muted mt-0.5 text-xs">
                          Sent {formatDate(invite.createdAt)}
                          {invite.invitedByEmail
                            ? ` by ${invite.invitedByEmail}`
                            : ''}{' '}
                          · expires {formatRelativeDays(invite.expiresAt)}
                        </p>
                      </div>
                      <InviteActions
                        accountId={accountId}
                        inviteId={invite.id}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card>
            <CardHeader
              title="AI credits"
              description="Credits are metered from real token counts, so a busy workspace with a big knowledge base burns them several times faster than a quiet one."
            />
            <CardBody className="space-y-5">
              <AdjustCredits
                accountId={accountId}
                balance={balance}
                creditMode={ai?.creditMode ?? null}
                maxAdjustment={maxCreditAdjustment()}
              />

              <div className="border-line grid gap-x-6 gap-y-3 border-t pt-4 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-muted text-xs">Bought, all time</p>
                  <p className="text-ink tabular mt-0.5 font-medium">
                    {formatCredits(wallet?.lifetimePurchased ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-muted text-xs">Consumed, all time</p>
                  <p className="text-ink tabular mt-0.5 font-medium">
                    {formatCredits(wallet?.lifetimeConsumed ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-muted text-xs">Welcome grant</p>
                  <p className="text-ink-2 mt-0.5 text-sm">
                    {wallet?.signupGrantedAt
                      ? formatDate(wallet.signupGrantedAt)
                      : 'not granted'}
                  </p>
                </div>
              </div>

              <DerivedNote>
                A manual adjustment does not count towards &ldquo;bought&rdquo;:
                that column is what the customer paid for, and a goodwill grant
                is us giving something away. Both land on the ledger below
                either way.
              </DerivedNote>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Credit ledger"
              description="Every movement, newest first. Append-only — a correction is a new row, never an edit."
            />
            {ledger.length === 0 ? (
              <CardBody>
                <p className="text-muted text-sm">
                  Nothing has moved in this wallet yet.
                </p>
              </CardBody>
            ) : (
              <ul className="divide-line divide-y">
                {ledger.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-2.5 text-sm"
                  >
                    <span className="text-ink-2 min-w-0">
                      {describeLedgerEntry(entry)}
                      {entry.note ? (
                        <span className="text-muted block text-xs">
                          {entry.note}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-right">
                      <span
                        className={`tabular font-medium ${entry.delta >= 0 ? 'text-good-ink' : 'text-ink'}`}
                      >
                        {formatDelta(entry.delta)}
                      </span>
                      <span className="text-muted block text-xs">
                        {formatDateTime(entry.createdAt)} · left{' '}
                        {formatCredits(entry.balanceAfter)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Workspace settings"
              description="The fields support gets asked about. Everything else about this workspace is edited by its own team inside the CRM."
            />
            <CardBody>
              <WorkspaceForm
                accountId={accountId}
                name={workspace.accountName}
                defaultCountry={workspace.defaultCountry}
                defaultCurrency={workspace.defaultCurrency}
              />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Plan & billing"
              action={
                <Link
                  href={`/subscribers/${workspace.ownerUserId}`}
                  className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
                >
                  Edit subscription
                </Link>
              }
            />
            <CardBody>
              <Facts
                items={[
                  {
                    label: 'Plan',
                    value: workspace.planDisplayName ?? 'None',
                    hint: workspace.planName ?? undefined,
                  },
                  {
                    label: 'Status',
                    value: workspace.status ?? 'No subscription',
                  },
                  {
                    label: 'Renews',
                    value: formatDate(workspace.periodEnd),
                    hint: workspace.periodEnd
                      ? formatRelativeDays(workspace.periodEnd)
                      : undefined,
                  },
                  { label: 'MRR', value: formatMoney(workspace.mrr) },
                  {
                    label: 'Billed to',
                    value: workspace.ownerEmail ?? workspace.ownerUserId,
                    hint: 'the owner — that is how subscriptions are keyed',
                  },
                  {
                    label: 'Onboarding',
                    value: workspace.onboardedAt
                      ? `Completed ${formatDate(workspace.onboardedAt)}`
                      : 'Not finished',
                  },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="AI setup" />
            <CardBody>
              {ai === null ? (
                <p className="text-muted text-sm">
                  This workspace has never opened the agent studio, so it has no
                  configuration row. It still has a wallet — every account gets
                  the welcome grant.
                </p>
              ) : (
                <Facts
                  items={[
                    {
                      label: 'Runs on',
                      value:
                        ai.creditMode === 'platform'
                          ? 'Our Gemini key (credits)'
                          : 'Their own provider key',
                      hint:
                        ai.creditMode === 'byok'
                          ? 'their provider bills them directly; nothing is metered'
                          : 'metered against the wallet above',
                    },
                    {
                      label: 'Provider / model',
                      value:
                        ai.creditMode === 'platform'
                          ? 'platform default'
                          : `${ai.provider ?? '—'} · ${ai.model ?? '—'}`,
                    },
                    {
                      label: 'Own key stored',
                      value: ai.hasOwnKey ? 'Yes (encrypted)' : 'No',
                    },
                    { label: 'Agent name', value: ai.agentName ?? 'Unnamed' },
                    { label: 'Active', value: ai.isActive ? 'Yes' : 'No' },
                    {
                      label: 'Auto-reply',
                      value: ai.autoReplyEnabled ? 'On' : 'Off',
                    },
                    {
                      label: 'Test mode',
                      value: ai.testMode
                        ? `On — ${ai.testNumbers.length} number(s) only`
                        : 'Off',
                    },
                    {
                      label: 'Knowledge / actions',
                      value: `${formatNumber(ai.knowledgeDocs)} document(s), ${formatNumber(ai.customActions)} action(s)`,
                    },
                    {
                      label: 'Embedding model',
                      value: ai.embeddingsModel ?? 'None indexed',
                    },
                  ]}
                />
              )}
              <DerivedNote>
                Provider keys are never read by this panel — not even truncated.
                &ldquo;Own key stored&rdquo; is a null check, nothing more.
              </DerivedNote>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Channels" />
            <CardBody>
              <Facts
                items={[
                  {
                    label: 'WhatsApp',
                    value: channels.whatsappStatus ?? 'Not connected',
                    hint: channels.whatsappNumberId
                      ? `number id ${channels.whatsappNumberId}`
                      : undefined,
                  },
                  {
                    label: 'Messaging tier',
                    value: channels.whatsappTier ?? '—',
                    hint: channels.whatsappQuality
                      ? `quality ${channels.whatsappQuality}`
                      : undefined,
                  },
                  {
                    label: 'WhatsApp token expires',
                    value: channels.whatsappTokenExpiresAt
                      ? formatDate(channels.whatsappTokenExpiresAt)
                      : 'No expiry recorded',
                    hint: channels.whatsappTokenExpiresAt
                      ? formatRelativeDays(channels.whatsappTokenExpiresAt)
                      : undefined,
                  },
                  {
                    label: 'Instagram',
                    value: channels.instagramStatus ?? 'Not connected',
                    hint: channels.instagramUsername ?? undefined,
                  },
                  {
                    label: 'Web widget',
                    value: channels.webStatus ?? 'Not installed',
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
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What they have built"
              description="Counted from the domain tables — the ground truth for whether this workspace is in real use."
            />
            <CardBody>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                {[
                  { label: 'Contacts', value: activity.contacts },
                  { label: 'Conversations', value: activity.conversations },
                  { label: 'Messages', value: activity.messages },
                  { label: 'Broadcasts', value: activity.broadcasts },
                  { label: 'Automations', value: activity.automations },
                  { label: 'Flows', value: activity.flows },
                  { label: 'Templates', value: activity.templates },
                  { label: 'Live API keys', value: activity.apiKeys },
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

          {orders.length > 0 ? (
            <Card>
              <CardHeader
                title="Credit top-ups"
                description="Real payments, unlike every subscription figure in this panel — an order records the amount Razorpay collected."
              />
              <ul className="divide-line divide-y">
                {orders.map((order) => (
                  <li
                    key={order.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-2.5 text-sm"
                  >
                    <span className="text-ink-2">
                      {formatCredits(order.credits)} credits
                      <span className="text-muted block text-xs">
                        {order.packCode} · {order.gateway}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="text-ink tabular font-medium">
                        {formatMinor(order.amountMinor, order.currency)}
                      </span>
                      <span className="text-muted block text-xs">
                        {order.creditedAt
                          ? `credited ${formatDate(order.creditedAt)}`
                          : `${order.status} · started ${formatDate(order.createdAt)}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {enquiries.length > 0 ? (
            <Card>
              <CardHeader
                title="Enterprise enquiries"
                description="A negotiated price lives only here — it contributes nothing to MRR."
              />
              <ul className="divide-line divide-y">
                {enquiries.map((enquiry) => (
                  <li key={enquiry.id} className="px-5 py-2.5 text-sm">
                    <p className="text-ink-2">
                      {enquiry.fullName}{' '}
                      <Badge tone="outline">{enquiry.status}</Badge>
                    </p>
                    <p className="text-muted text-xs">
                      {enquiry.workEmail}
                      {enquiry.companySize
                        ? ` · ${enquiry.companySize}`
                        : ''} · {formatDate(enquiry.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Admin activity"
              description="Changes made from this panel."
              action={
                <Link
                  href={`/audit?accountId=${accountId}`}
                  className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
                >
                  Full log
                </Link>
              }
            />
            {audit.length === 0 ? (
              <CardBody>
                <p className="text-muted text-sm">
                  Nothing has been changed here from the admin panel.
                </p>
              </CardBody>
            ) : (
              <ul className="divide-line divide-y">
                {audit.map((entry) => (
                  <li key={entry.id} className="px-5 py-2.5 text-sm">
                    <p className="text-ink-2">{entry.summary}</p>
                    <p className="text-muted text-xs">
                      {entry.actor} · {formatDateTime(entry.createdAt)}
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

/**
 * A ledger row in one line.
 *
 * `feature` is only ever set on a `usage` row, so a grant reads as what granted
 * it rather than as a feature that does not exist.
 */
function describeLedgerEntry(entry: LedgerEntry): string {
  const REASONS: Record<string, string> = {
    signup_grant: 'Welcome grant',
    purchase: 'Top-up purchased',
    usage: 'Usage',
    refund: 'Refund',
    plan_grant: 'Included with plan',
    admin_adjust: 'Manual adjustment',
  };

  const base = REASONS[entry.reason] ?? entry.reason;

  if (entry.reason !== 'usage') return base;

  const FEATURES: Record<string, string> = {
    draft: 'Inbox draft',
    auto_reply: 'Auto-reply',
    playground: 'Playground',
    embedding: 'Knowledge indexing',
  };

  const what = entry.feature
    ? (FEATURES[entry.feature] ?? entry.feature)
    : base;
  const tokens =
    entry.inputTokens + entry.outputTokens > 0
      ? ` · ${formatNumber(entry.inputTokens)} in / ${formatNumber(entry.outputTokens)} out`
      : '';

  return `${what}${entry.model ? ` · ${entry.model}` : ''}${tokens}`;
}
