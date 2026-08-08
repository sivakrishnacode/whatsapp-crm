'use server';

import { refresh } from 'next/cache';

import { recordAudit } from '@/lib/actions/audit';
import { FieldError, oneOf, text, uuid } from '@/lib/actions/parse';
import type { ActionState } from '@/lib/actions/subscriptions';
import { requireAdmin } from '@/lib/auth';
import type { AdminSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';

/**
 * Workspace and membership writes.
 *
 * ## Why this file re-implements three RPCs instead of calling them
 *
 * `set_member_role`, `remove_account_member` and `transfer_account_ownership`
 * (migration 018) already encode exactly these rules — but every one of them
 * starts with `IF auth.uid() IS NULL THEN RAISE 'Unauthorized'`, because they
 * are SECURITY DEFINER functions granted to `authenticated` and that check is
 * the only thing standing between a signed-in customer and another tenant's
 * profiles. This panel connects as the database owner with no JWT at all, so
 * `auth.uid()` is NULL and every one of them refuses.
 *
 * Relaxing that check would remove the guard from the customer's path too. So
 * the rules are re-stated here, and they must stay in step with 018:
 *
 *   - a role change never touches an owner, in either direction
 *   - the owner cannot be removed; ownership is transferred instead
 *   - a removed member keeps their login and lands in their own workspace
 *   - a transfer demotes and promotes in one transaction, so the account is
 *     never briefly ownerless
 *
 * ⚠️ Nothing here writes to `auth.users`. Banning or deleting a login belongs to
 * Supabase's admin API — a SQL UPDATE on `banned_until` skips the session
 * revocation that would make it take effect, so the user stays signed in and the
 * panel reports a lie.
 */

/** Owner is absent on purpose — see `transferOwnership`. */
const ASSIGNABLE_ROLES = ['admin', 'agent', 'viewer'] as const;

const MEMBER_INTENTS = ['set_role', 'remove', 'transfer_ownership'] as const;

const COUNTRY_RE = /^[A-Za-z]{2}$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

export async function updateWorkspace(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await requireAdmin();

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const name = text(formData, 'name', 'Workspace name');
    const country = text(formData, 'defaultCountry', 'Default country');
    const currencyCode = text(formData, 'defaultCurrency', 'Default currency');

    if (!COUNTRY_RE.test(country)) {
      throw new FieldError(
        'Default country must be a 2-letter ISO code, e.g. IN or AE.'
      );
    }
    if (!CURRENCY_RE.test(currencyCode)) {
      throw new FieldError(
        'Default currency must be a 3-letter ISO code, e.g. INR or USD.'
      );
    }

    const existing = await prisma.account.findUnique({
      where: { id: accountId },
      select: { name: true, defaultCountry: true, defaultCurrency: true },
    });
    if (!existing) throw new FieldError('That workspace no longer exists.');

    await prisma.account.update({
      where: { id: accountId },
      data: {
        name,
        defaultCountry: country.toUpperCase(),
        defaultCurrency: currencyCode.toUpperCase(),
        updatedAt: new Date(),
      },
    });

    await recordAudit({
      actor: session.username,
      action: 'workspace.update',
      targetType: 'workspace',
      targetId: accountId,
      accountId,
      summary: `Updated workspace ${existing.name} → ${name}`,
      detail: {
        from: existing,
        to: {
          name,
          defaultCountry: country.toUpperCase(),
          defaultCurrency: currencyCode.toUpperCase(),
        },
      },
    });

    refresh();

    // `default_country` is not cosmetic: it is the country assumed for any
    // phone number entered without a code, on every contact write path (see
    // toE164 in the api). Changing it does not re-parse what is already stored.
    const countryNote =
      existing.defaultCountry !== country.toUpperCase()
        ? ' Contacts already saved keep the numbers they were parsed into —' +
          ' only new ones use the new country.'
        : '';

    return { ok: `Saved ${name}.${countryNote}` };
  } catch (error) {
    return toState(error, 'workspace write');
  }
}

/**
 * One action for every per-member button, dispatched on `intent`.
 *
 * Same shape as the subscription quick actions: a submit button's name/value
 * rides along in the FormData, so a member row is one form with one result
 * message rather than three forms racing each other.
 */
export async function memberAction(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await requireAdmin();

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const userId = uuid(formData, 'userId', 'Member');
    const intent = oneOf(formData, 'intent', MEMBER_INTENTS, {
      label: 'Action',
    })!;

    const member = await loadMember(accountId, userId);

    switch (intent) {
      case 'set_role':
        return await setMemberRole(session, formData, accountId, userId, member);
      case 'remove':
        return await removeMember(session, accountId, userId, member);
      case 'transfer_ownership':
        return await transferOwnership(session, accountId, userId, member);
    }
  } catch (error) {
    return toState(error, 'member write');
  }
}

type Member = Awaited<ReturnType<typeof loadMember>>;

async function setMemberRole(
  session: AdminSession,
  formData: FormData,
  accountId: string,
  userId: string,
  member: Member
): Promise<ActionState> {
  const role = oneOf(formData, 'role', ASSIGNABLE_ROLES, { label: 'Role' })!;

  if (member.isOwner) {
    throw new FieldError(
      'This member owns the workspace. Transfer ownership to someone else ' +
        'first — an account with no owner has nobody to bill.'
    );
  }
  if (member.accountRole === role) {
    throw new FieldError(`They are already ${role}.`);
  }

  await prisma.profile.update({
    where: { userId },
    data: { accountRole: role, updatedAt: new Date() },
  });

  await recordAudit({
    actor: session.username,
    action: 'member.role',
    targetType: 'member',
    targetId: userId,
    accountId,
    userId,
    summary:
      `Changed ${member.label}'s role in ${member.accountName} from ` +
      `${member.accountRole} to ${role}`,
    detail: { from: member.accountRole, to: role },
  });

  refresh();
  return { ok: `${member.label} is now ${role}.` };
}

/**
 * Remove someone from a workspace without taking their login away.
 *
 * The mirror of `remove_account_member`: the profile moves to a workspace of
 * their own, as its owner, rather than being deleted. Deleting it would leave an
 * authenticated user with no profile — a state the CRM reads as "signed up but
 * never onboarded", which bounces them into `/welcome` to buy a plan for a
 * workspace they never asked for.
 *
 * One difference from the RPC, forced by the schema: `accounts.owner_user_id` is
 * UNIQUE (`idx_accounts_one_per_owner`), so if this user still owns the personal
 * account they were given at signup, inserting a second one fails outright.
 * `redeem_invitation` normally deletes that empty account when they join a team,
 * but a profile moved by hand may never have gone through it — so an existing
 * owned workspace is reused instead of blindly creating one.
 */
async function removeMember(
  session: AdminSession,
  accountId: string,
  userId: string,
  member: Member
): Promise<ActionState> {
  if (member.isOwner) {
    throw new FieldError(
      'The workspace owner cannot be removed. Transfer ownership first.'
    );
  }

  const landedIn = await prisma.$transaction(async (tx) => {
    const owned = await tx.account.findUnique({
      where: { ownerUserId: userId },
      select: { id: true, name: true },
    });

    const destination =
      owned ??
      (await tx.account.create({
        // Same naming as the RPC: their own name, else their email, else a
        // placeholder. Never the workspace they are leaving.
        data: {
          name: member.fullName?.trim() || member.email || 'My workspace',
          ownerUserId: userId,
        },
        select: { id: true, name: true },
      }));

    await tx.profile.update({
      where: { userId },
      data: {
        accountId: destination.id,
        accountRole: 'owner',
        updatedAt: new Date(),
      },
    });

    return destination;
  });

  await recordAudit({
    actor: session.username,
    action: 'member.remove',
    targetType: 'member',
    targetId: userId,
    accountId,
    userId,
    summary:
      `Removed ${member.label} from ${member.accountName}; moved to their own ` +
      `workspace "${landedIn.name}"`,
    detail: {
      previousRole: member.accountRole,
      newAccountId: landedIn.id,
      assignedDeals: member.assignedDeals,
    },
  });

  refresh();

  // `deals.assigned_to` is a FK to profiles.id with no cascade, so those deals
  // still point at this profile — which now lives in another workspace. Nothing
  // breaks, but the assignee reads as unavailable to the team that kept them.
  const deals =
    member.assignedDeals > 0
      ? ` ${member.assignedDeals} deal(s) are still assigned to them —` +
        ' reassign those in the CRM.'
      : '';

  return {
    ok:
      `${member.label} no longer has access to ${member.accountName}. Their ` +
      `login still works and now opens their own workspace.${deals}`,
  };
}

/**
 * Hand a workspace to one of its members.
 *
 * Three writes in one transaction so the account is never ownerless: demote the
 * current owner to admin, promote the target, repoint `accounts.owner_user_id`.
 *
 * ⚠️ And a fourth the RPC does not do, because the CRM never had to: THE
 * SUBSCRIPTION MOVES TOO. A plan belongs to the workspace, but
 * `user_subscriptions` is keyed by user and everything — this panel, the pricing
 * page, `get_user_subscription()` — resolves a workspace's plan through
 * `accounts.owner_user_id`. Leaving the row behind would make the workspace read
 * as having no plan while still billing someone who no longer runs it.
 *
 * If the incoming owner already has a subscription row, that move is impossible
 * (`user_subscriptions.user_id` is UNIQUE) and it is also not obviously right:
 * two plans exist and only a human knows which survives. So the transfer is
 * refused with that explanation rather than guessed at.
 *
 * ⚠️ The same shape catches `accounts.owner_user_id`, which is UNIQUE
 * (`idx_accounts_one_per_owner`) — one workspace per owner. Someone who joined
 * by invitation has no other workspace, because `redeem_invitation` deletes
 * their empty personal one on the way in; but someone who was removed from a
 * workspace and re-added by hand does own one, and promoting them would hit the
 * constraint. That is checked up front so it reads as a sentence rather than a
 * P2002 in the logs. Deleting their other workspace to make room is deliberately
 * not done here: it is somebody's account, not an obstacle.
 */
async function transferOwnership(
  session: AdminSession,
  accountId: string,
  userId: string,
  member: Member
): Promise<ActionState> {
  if (member.isOwner) {
    throw new FieldError('They already own this workspace.');
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { ownerUserId: true, name: true },
  });
  if (!account) throw new FieldError('That workspace no longer exists.');

  const [outgoing, incoming, alreadyOwns] = await Promise.all([
    prisma.user_subscriptions.findUnique({
      where: { user_id: account.ownerUserId },
      select: { id: true, subscription_plans: { select: { name: true } } },
    }),
    prisma.user_subscriptions.findUnique({
      where: { user_id: userId },
      select: { id: true, subscription_plans: { select: { name: true } } },
    }),
    prisma.account.findUnique({
      where: { ownerUserId: userId },
      select: { id: true, name: true },
    }),
  ]);

  if (alreadyOwns) {
    throw new FieldError(
      `${member.label} already owns another workspace ("${alreadyOwns.name}"), ` +
        'and the schema allows one owner per workspace. Move or wind that one ' +
        'down first, or promote a different member.'
    );
  }

  if (outgoing && incoming) {
    throw new FieldError(
      `Both people have their own subscription — ${account.name} is on ` +
        `${outgoing.subscription_plans.name} and the incoming owner is on ` +
        `${incoming.subscription_plans.name}. Cancel or reassign one of them ` +
        'first, or the workspace ends up billed twice.'
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.profile.update({
      where: { userId: account.ownerUserId },
      data: { accountRole: 'admin', updatedAt: new Date() },
    });
    await tx.profile.update({
      where: { userId },
      data: { accountRole: 'owner', updatedAt: new Date() },
    });
    await tx.account.update({
      where: { id: accountId },
      data: { ownerUserId: userId, updatedAt: new Date() },
    });

    if (outgoing) {
      await tx.user_subscriptions.update({
        where: { id: outgoing.id },
        data: { user_id: userId, updated_at: new Date() },
      });
    }
  });

  await recordAudit({
    actor: session.username,
    action: 'workspace.transfer_ownership',
    targetType: 'workspace',
    targetId: accountId,
    accountId,
    userId,
    summary:
      `Transferred ownership of ${account.name} to ${member.label}` +
      (outgoing
        ? ` and moved the ${outgoing.subscription_plans.name} subscription with it`
        : ''),
    detail: {
      previousOwnerUserId: account.ownerUserId,
      movedSubscriptionId: outgoing?.id ?? null,
    },
  });

  refresh();

  // `usage_tracking` is keyed by user + period too, and is NOT moved: the
  // counters the CRM enforces limits against are now the new owner's, which
  // start at zero for the current period. Better said out loud than discovered
  // as a month of free headroom.
  const billing = outgoing
    ? ' The subscription moved with it; usage counters for the current period' +
      ' did not, so limits are measured from zero until the next one.'
    : ' This workspace has no subscription attached, so nothing billing changed' +
      ' hands.';

  return {
    ok:
      `${member.label} now owns ${account.name}. The previous owner is an ` +
      `admin.${billing}`,
  };
}

/**
 * Revoke a pending invitation.
 *
 * A hard delete rather than a status flag, matching the api's own endpoint: an
 * invitation's authority IS its `token_hash` row, so deleting the row is what
 * makes the emailed link stop working.
 */
export async function revokeInvitation(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await requireAdmin();

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const inviteId = uuid(formData, 'inviteId', 'Invitation');

    const invite = await prisma.account_invitations.findUnique({
      where: { id: inviteId },
      select: {
        account_id: true,
        label: true,
        role: true,
        accepted_at: true,
        accounts: { select: { name: true } },
      },
    });

    if (!invite || invite.account_id !== accountId) {
      throw new FieldError('That invitation no longer exists.');
    }
    if (invite.accepted_at) {
      throw new FieldError(
        'That invitation has already been accepted — remove the member instead.'
      );
    }

    await prisma.account_invitations.delete({ where: { id: inviteId } });

    await recordAudit({
      actor: session.username,
      action: 'invitation.revoke',
      targetType: 'invitation',
      targetId: inviteId,
      accountId,
      summary:
        `Revoked the ${invite.role} invitation` +
        `${invite.label ? ` for ${invite.label}` : ''} on ${invite.accounts.name}`,
      detail: { role: invite.role, label: invite.label },
    });

    refresh();
    return { ok: 'Invitation revoked. The link no longer works.' };
  } catch (error) {
    return toState(error, 'invitation revoke');
  }
}

/**
 * Load a member and prove they belong to the workspace being edited.
 *
 * Every action here takes both an accountId and a userId from the form, and a
 * Server Action is reachable by direct POST — so the pair has to be checked
 * together. Trusting the userId alone is how a page about one workspace becomes
 * a way to edit any profile in the database.
 */
async function loadMember(accountId: string, userId: string) {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: {
      id: true,
      accountId: true,
      accountRole: true,
      fullName: true,
      email: true,
      account: { select: { name: true, ownerUserId: true } },
      _count: { select: { deals: true } },
    },
  });

  if (!profile || profile.accountId !== accountId) {
    throw new FieldError('That person is not a member of this workspace.');
  }

  return {
    profileId: profile.id,
    accountRole: profile.accountRole,
    accountName: profile.account.name,
    fullName: profile.fullName,
    email: profile.email,
    label: profile.fullName?.trim() || profile.email || 'That member',
    isOwner: profile.account.ownerUserId === userId,
    assignedDeals: profile._count.deals,
  };
}

function toState(error: unknown, what: string): ActionState {
  if (error instanceof FieldError) return { error: error.message };
  console.error(`[admin-panel] ${what} failed`, error);
  return { error: 'Could not save that change. Check the logs.' };
}
