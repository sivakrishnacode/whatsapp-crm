import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AddMember } from '@/components/workspace/add-member';
import { InviteActions } from '@/components/workspace/invite-actions';
import { MemberActions } from '@/components/workspace/member-actions';
import { WorkspaceForm } from '@/components/workspace/workspace-form';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Callout } from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import { can, requireCapability } from '@/lib/auth';
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatRelativeDays,
  initialsOf,
} from '@/lib/format';
import { isUuid } from '@/lib/ids';
import { prisma } from '@/lib/prisma';
import {
  getWorkspaceRow,
  listInvites,
  listMembers,
} from '@/lib/queries/workspaces';

export const metadata: Metadata = { title: 'Team · Customer 360' };

/**
 * Team & seats: who can sign in to this workspace and with which role. The
 * membership actions re-implement migration 018's RPCs (which refuse this
 * panel's NULL auth.uid()) — see lib/actions/workspaces.ts. Only roles with
 * `members.manage` see the controls; transferring ownership additionally
 * needs billing rights because it moves the subscription row.
 */
export default async function ClientTeamPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const staff = await requireCapability('clients.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();

  const [workspace, members, invites] = await Promise.all([
    getWorkspaceRow(accountId),
    listMembers(accountId),
    listInvites(accountId),
  ]);
  if (!workspace) notFound();

  // The cap check_account_limit applies (migration 075): the OWNER's plan,
  // NULL = unlimited. Read here so the tile shows the real limit, not a guess.
  const plan = workspace.planName
    ? await prisma.subscription_plans.findUnique({
        where: { name: workspace.planName },
        select: { display_name: true, max_team_members: true },
      })
    : null;
  const seatLimit = plan ? plan.max_team_members : null;

  const canManage = can(staff, 'members.manage');
  const showMoney = can(staff, 'billing.read');
  const duplicateBilling = members.filter(
    (m) => !m.isAccountOwner && m.ownSubscriptionStatus !== null
  );
  const byRole = members.reduce<Record<string, number>>(
    (acc, m) => ({ ...acc, [m.accountRole]: (acc[m.accountRole] ?? 0) + 1 }),
    {}
  );
  const neverSignedIn = members.filter((m) => !m.lastSignInAt).length;

  return (
    <div className="space-y-6">
      <StatRow>
        <StatTile
          label="Members"
          value={formatNumber(members.length)}
          context={`${byRole.admin ?? 0} admin · ${byRole.agent ?? 0} agent · ${byRole.viewer ?? 0} viewer`}
        />
        <StatTile
          label="Open invitations"
          value={formatNumber(invites.length)}
        />
        <StatTile
          label="Never signed in"
          value={formatNumber(neverSignedIn)}
          tone={neverSignedIn > 0 ? 'warning' : 'neutral'}
          context="invited or added, no login yet"
        />
        <StatTile
          label="Seats used"
          value={
            seatLimit === null
              ? formatNumber(members.length)
              : `${members.length} / ${seatLimit}`
          }
          tone={
            seatLimit !== null && members.length >= seatLimit
              ? 'warning'
              : 'neutral'
          }
          context={
            plan
              ? `${plan.display_name} allows ${seatLimit === null ? 'unlimited' : seatLimit} team members`
              : 'no plan — no seat limit applies'
          }
        />
      </StatRow>

      {showMoney && duplicateBilling.length > 0 ? (
        <Callout
          tone="warn"
          title="More than one subscription in this workspace"
        >
          A plan belongs to the workspace, but subscriptions are keyed by user —
          only the owner&apos;s row is the workspace&apos;s plan.{' '}
          {duplicateBilling.map((m) => (
            <span key={m.userId}>
              {m.fullName || m.email} is on {m.ownSubscriptionPlan} (
              {m.ownSubscriptionStatus}, {formatMoney(m.ownSubscriptionMrr)}
              /mo).{' '}
            </span>
          ))}
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader
            title="People in this workspace"
            description="Removing someone keeps their login. If this is their only workspace they will have none — the CRM shows them that honestly."
          />
          {members.length === 0 ? (
            <EmptyState>
              No memberships. The owner&apos;s membership row may be missing —
              check the audit log.
            </EmptyState>
          ) : (
            <ul className="divide-line divide-y">
              {members.map((member) => (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-start justify-between gap-4 px-5 py-4"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      aria-hidden
                      className="bg-primary-soft text-primary-soft-ink grid size-9 shrink-0 place-items-center rounded-full text-xs font-bold"
                    >
                      {initialsOf(member.fullName, member.email)}
                    </span>
                    <div className="min-w-0">
                      <p className="text-ink flex flex-wrap items-center gap-2 font-semibold">
                        <span className="truncate">
                          {member.fullName || member.email || 'Unnamed user'}
                        </span>
                        <Badge>{member.accountRole}</Badge>
                        {member.isAccountOwner ? (
                          <Badge tone="outline">owner of record</Badge>
                        ) : null}
                      </p>
                      <p className="text-muted mt-0.5 truncate text-xs">
                        {member.email}
                      </p>
                      <p className="text-muted mt-1 text-xs">
                        {member.lastSignInAt
                          ? `Last sign-in ${formatDate(member.lastSignInAt)}`
                          : 'Never signed in'}
                        {member.emailConfirmedAt
                          ? ''
                          : ' · email not confirmed'}
                        {member.bannedUntil && member.bannedUntil > new Date()
                          ? ` · banned until ${formatDate(member.bannedUntil)}`
                          : ''}
                        {member.otherWorkspaces > 0
                          ? ` · also in ${member.otherWorkspaces} other workspace${member.otherWorkspaces === 1 ? '' : 's'}`
                          : member.isAccountOwner
                            ? ''
                            : ' · only workspace'}
                        {member.assignedDeals > 0
                          ? ` · ${member.assignedDeals} assigned deal(s)`
                          : ''}
                      </p>
                    </div>
                  </div>
                  {canManage ? (
                    <MemberActions
                      accountId={accountId}
                      userId={member.userId}
                      role={member.accountRole}
                      isOwner={member.isAccountOwner}
                      assignedDeals={member.assignedDeals}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {canManage ? (
            <div className="border-line border-t px-5 py-4">
              <p className="text-ink-2 mb-2 text-xs font-semibold">
                Add an existing login
              </p>
              <AddMember accountId={accountId} />
            </div>
          ) : null}
        </Card>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Open invitations"
              description="Sent from the CRM by the workspace's own admins."
            />
            {invites.length === 0 ? (
              <EmptyState>No open invitations.</EmptyState>
            ) : (
              <ul className="divide-line divide-y">
                {invites.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
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
                    {canManage ? (
                      <InviteActions
                        accountId={accountId}
                        inviteId={invite.id}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Workspace settings"
              description="The fields support gets asked to change. Everything else is edited by the customer's own team."
            />
            <CardBody>
              {canManage ? (
                <WorkspaceForm
                  accountId={accountId}
                  name={workspace.accountName}
                  defaultCountry={workspace.defaultCountry}
                  defaultCurrency={workspace.defaultCurrency}
                />
              ) : (
                <p className="text-ink-2 text-sm">
                  {workspace.accountName} · country {workspace.defaultCountry} ·
                  currency {workspace.defaultCurrency}
                </p>
              )}
            </CardBody>
          </Card>

          <p className="text-muted px-1 text-xs leading-relaxed">
            Need someone who has never signed up? Invitations are created inside
            the CRM by the workspace&apos;s admins; this panel does not mint
            logins. See{' '}
            <Link href="/users" className="text-primary hover:underline">
              People &amp; Logins
            </Link>{' '}
            for every login across the platform.
          </p>
        </div>
      </div>
    </div>
  );
}
