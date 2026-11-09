'use server';

import { Prisma } from '@prisma/client';
import { refresh } from 'next/cache';

import { recordAudit } from '@/lib/actions/audit';
import { FieldError, oneOf, text, uuid } from '@/lib/actions/parse';
import type { ActionState } from '@/lib/actions/subscriptions';
import {
  authorizeAction,
  getStaff,
  startSession,
  type Staff,
} from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  MIN_PASSWORD_LENGTH,
  generateTemporaryPassword,
  hashPassword,
  verifyPassword,
} from '@/lib/staff/password';
import { ROLE_LABEL, STAFF_ROLES, type StaffRole } from '@/lib/staff/roles';

/**
 * Staff & Access writes (Super Admin — `staff.manage`), plus changing your own
 * password (any signed-in staff member).
 *
 * ## Sessions are revoked by bumping `session_version`
 *
 * Every session JWT carries the version it was minted under and `getStaff()`
 * compares it with the row on every request. So a role change, deactivation,
 * password reset or explicit revoke takes effect on that person's NEXT
 * REQUEST — not when their 12-hour cookie happens to expire.
 *
 * ## Passwords
 *
 * A new or reset account gets a generated temporary password, returned in the
 * action result ONCE and never stored anywhere but as a scrypt hash — not in
 * the audit log, not in a log line. If it is lost, reset it again.
 *
 * ## The last Super Admin
 *
 * Deactivating or demoting the last active Super Admin is refused: with the
 * break-glass env login unset, nobody could ever manage staff again. (The
 * check is read-then-write; two Super Admins demoting each other in the same
 * second could both succeed. The break-glass login is the recovery for that.)
 */

export type StaffActionState = ActionState & {
  /** A temporary password, shown once. */
  secret?: string;
  /** Who the secret is for, so the UI can say so. */
  secretFor?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTENTS = [
  'set_role',
  'deactivate',
  'reactivate',
  'reset_password',
  'revoke_sessions',
] as const;

function toState(error: unknown, what: string): StaffActionState {
  if (error instanceof FieldError) return { error: error.message };
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    return { error: 'A staff account with that email already exists.' };
  }
  console.error(`[admin-panel] ${what} failed`, error);
  return { error: 'Could not save that change. Check the logs.' };
}

async function activeSuperAdmins(excludingId?: string): Promise<number> {
  return prisma.admin_staff.count({
    where: {
      role: 'super_admin',
      is_active: true,
      ...(excludingId ? { id: { not: excludingId } } : {}),
    },
  });
}

export async function createStaff(
  _previous: StaffActionState,
  formData: FormData
): Promise<StaffActionState> {
  const auth = await authorizeAction('staff.manage');
  if (auth.error) return { error: auth.error };
  const { staff } = auth;

  try {
    const email = text(formData, 'email', 'Email').toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) {
      throw new FieldError('That is not a valid email address.');
    }
    const fullName = text(formData, 'fullName', 'Name');
    if (fullName.length > 80) {
      throw new FieldError('Name must be 80 characters or fewer.');
    }
    const role = oneOf(formData, 'role', STAFF_ROLES, { label: 'Role' })!;

    const existing = await prisma.admin_staff.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      throw new FieldError('A staff account with that email already exists.');
    }

    const temporary = generateTemporaryPassword();
    const created = await prisma.admin_staff.create({
      data: {
        email,
        full_name: fullName,
        role,
        password_hash: await hashPassword(temporary),
        created_by: staff.actor,
      },
      select: { id: true },
    });

    await recordAudit({
      actor: staff.actor,
      action: 'staff.create',
      targetType: 'staff',
      targetId: created.id,
      summary: `Created staff account ${email} as ${ROLE_LABEL[role]}.`,
      detail: { email, fullName, role },
    });

    refresh();
    return {
      ok: `Created ${email}. Hand them the temporary password below — it is shown once.`,
      secret: temporary,
      secretFor: email,
    };
  } catch (error) {
    return toState(error, 'staff create');
  }
}

export async function staffAction(
  _previous: StaffActionState,
  formData: FormData
): Promise<StaffActionState> {
  const auth = await authorizeAction('staff.manage');
  if (auth.error) return { error: auth.error };
  const { staff } = auth;

  try {
    const staffId = uuid(formData, 'staffId', 'Staff member');
    const intent = oneOf(formData, 'intent', INTENTS, { label: 'Action' })!;

    const target = await prisma.admin_staff.findUnique({
      where: { id: staffId },
      select: { id: true, email: true, role: true, is_active: true },
    });
    if (!target) throw new FieldError('That staff account no longer exists.');

    const isSelf = staff.id === target.id;

    switch (intent) {
      case 'set_role':
        return await setRole(staff, formData, target, isSelf);
      case 'deactivate':
        return await deactivate(staff, target, isSelf);
      case 'reactivate':
        return await reactivate(staff, target);
      case 'reset_password':
        return await resetPassword(staff, target);
      case 'revoke_sessions':
        return await revokeSessions(staff, target);
    }
  } catch (error) {
    return toState(error, 'staff write');
  }
}

type Target = { id: string; email: string; role: string; is_active: boolean };

async function setRole(
  staff: Staff,
  formData: FormData,
  target: Target,
  isSelf: boolean
): Promise<StaffActionState> {
  const role = oneOf(formData, 'role', STAFF_ROLES, { label: 'Role' })!;
  if (isSelf) {
    throw new FieldError(
      'You cannot change your own role. Ask another Super Admin.'
    );
  }
  if (role === target.role) {
    throw new FieldError(`They are already ${ROLE_LABEL[role]}.`);
  }
  if (
    target.role === 'super_admin' &&
    target.is_active &&
    (await activeSuperAdmins(target.id)) === 0
  ) {
    throw new FieldError(
      'They are the last active Super Admin. Promote someone else first.'
    );
  }

  await prisma.admin_staff.update({
    where: { id: target.id },
    data: {
      role,
      session_version: { increment: 1 },
      updated_at: new Date(),
    },
  });

  const from = ROLE_LABEL[target.role as StaffRole] ?? target.role;
  await recordAudit({
    actor: staff.actor,
    action: 'staff.role',
    targetType: 'staff',
    targetId: target.id,
    summary: `Changed ${target.email} from ${from} to ${ROLE_LABEL[role]}; their sessions were signed out.`,
    detail: { email: target.email, from: target.role, to: role },
  });

  refresh();
  return {
    ok: `${target.email} is now ${ROLE_LABEL[role]}. They will be asked to sign in again.`,
  };
}

async function deactivate(
  staff: Staff,
  target: Target,
  isSelf: boolean
): Promise<StaffActionState> {
  if (isSelf) throw new FieldError('You cannot deactivate yourself.');
  if (!target.is_active) throw new FieldError('They are already deactivated.');
  if (
    target.role === 'super_admin' &&
    (await activeSuperAdmins(target.id)) === 0
  ) {
    throw new FieldError(
      'They are the last active Super Admin. Promote someone else first.'
    );
  }

  await prisma.admin_staff.update({
    where: { id: target.id },
    data: {
      is_active: false,
      session_version: { increment: 1 },
      updated_at: new Date(),
    },
  });

  await recordAudit({
    actor: staff.actor,
    action: 'staff.deactivate',
    targetType: 'staff',
    targetId: target.id,
    summary: `Deactivated ${target.email}; their sessions ended immediately.`,
    detail: { email: target.email, role: target.role },
  });

  refresh();
  return {
    ok: `${target.email} is deactivated and signed out. Their clients, tickets and notes keep their name.`,
  };
}

async function reactivate(
  staff: Staff,
  target: Target
): Promise<StaffActionState> {
  if (target.is_active) throw new FieldError('They are already active.');

  await prisma.admin_staff.update({
    where: { id: target.id },
    data: {
      is_active: true,
      session_version: { increment: 1 },
      updated_at: new Date(),
    },
  });

  await recordAudit({
    actor: staff.actor,
    action: 'staff.reactivate',
    targetType: 'staff',
    targetId: target.id,
    summary: `Reactivated ${target.email}.`,
    detail: { email: target.email, role: target.role },
  });

  refresh();
  return {
    ok: `${target.email} can sign in again with their existing password. Reset it if that is not what you want.`,
  };
}

async function resetPassword(
  staff: Staff,
  target: Target
): Promise<StaffActionState> {
  const temporary = generateTemporaryPassword();

  await prisma.admin_staff.update({
    where: { id: target.id },
    data: {
      password_hash: await hashPassword(temporary),
      session_version: { increment: 1 },
      updated_at: new Date(),
    },
  });

  await recordAudit({
    actor: staff.actor,
    action: 'staff.reset_password',
    targetType: 'staff',
    targetId: target.id,
    summary: `Reset the password for ${target.email}; their sessions were signed out.`,
    detail: { email: target.email },
  });

  refresh();
  return {
    ok: `New temporary password for ${target.email} — shown once. They should change it from their account menu.`,
    secret: temporary,
    secretFor: target.email,
  };
}

async function revokeSessions(
  staff: Staff,
  target: Target
): Promise<StaffActionState> {
  await prisma.admin_staff.update({
    where: { id: target.id },
    data: { session_version: { increment: 1 }, updated_at: new Date() },
  });

  await recordAudit({
    actor: staff.actor,
    action: 'staff.revoke_sessions',
    targetType: 'staff',
    targetId: target.id,
    summary: `Signed ${target.email} out of every session.`,
    detail: { email: target.email },
  });

  refresh();
  return {
    ok:
      staff.id === target.id
        ? 'Every session of yours has been signed out, including this one.'
        : `${target.email} is signed out everywhere.`,
  };
}

/* ============================================================
 * Your own password — any signed-in staff member.
 * ============================================================ */

export async function changeOwnPassword(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const staff = await getStaff();
  if (!staff) return { error: 'Your session has ended. Sign in again.' };
  if (staff.isBreakGlass || !staff.id) {
    return {
      error:
        'The break-glass login has no stored password to change — it is set in the deployment env file.',
    };
  }

  try {
    const current = formData.get('current');
    const next = formData.get('next');
    const confirm = formData.get('confirm');
    if (
      typeof current !== 'string' ||
      typeof next !== 'string' ||
      typeof confirm !== 'string' ||
      !current ||
      !next
    ) {
      throw new FieldError('Fill in every field.');
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      throw new FieldError(
        `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`
      );
    }
    if (next.length > 200) {
      throw new FieldError('That password is too long.');
    }
    if (next !== confirm) {
      throw new FieldError('The new password and its confirmation differ.');
    }
    if (next === current) {
      throw new FieldError('The new password is the same as the current one.');
    }

    const row = await prisma.admin_staff.findUnique({
      where: { id: staff.id },
      select: { password_hash: true },
    });
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      throw new FieldError('Your current password is not correct.');
    }

    const updated = await prisma.admin_staff.update({
      where: { id: staff.id },
      data: {
        password_hash: await hashPassword(next),
        // Signs out every OTHER session (a stolen cookie included); this
        // one is re-issued below under the new version.
        session_version: { increment: 1 },
        updated_at: new Date(),
      },
      select: { session_version: true },
    });

    await startSession({
      subject: staff.id,
      role: staff.role,
      version: updated.session_version,
    });

    await recordAudit({
      actor: staff.actor,
      action: 'staff.change_password',
      targetType: 'staff',
      targetId: staff.id,
      summary: `${staff.email} changed their own password; other sessions were signed out.`,
    });

    return {
      ok: 'Password changed. Every other session of yours has been signed out.',
    };
  } catch (error) {
    return toState(error, 'password change');
  }
}
