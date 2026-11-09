'use server';

import { refresh } from 'next/cache';

import { recordAudit } from '@/lib/actions/audit';
import {
  FieldError,
  boolean,
  date,
  oneOf,
  optionalText,
  text,
  uuid,
} from '@/lib/actions/parse';
import type { ActionState } from '@/lib/actions/subscriptions';
import { authorizeAction, type Staff } from '@/lib/auth';
import { LIFECYCLE_STAGES } from '@/lib/lifecycle';
import { prisma } from '@/lib/prisma';
import { getRosterEntry } from '@/lib/queries/roster';

/**
 * Client operations writes (C360-022/023): ownership, service tier, tags,
 * lifecycle pins, notes and follow-up tasks.
 *
 * None of these touch the customer's product data — they write only the
 * Control Center's own tables (migration 098). That is why an account manager
 * may make them without the billing or membership capabilities.
 *
 * Every action re-checks its capability (a Server Action is reachable by
 * direct POST whatever the page rendered), re-validates that the workspace
 * exists, writes, then records an audit row AFTER the write succeeded.
 */

const TIERS = ['standard', 'priority', 'enterprise'] as const;
const MAX_TAGS = 10;
const TAG_RE = /^[a-z0-9][a-z0-9 -]{0,31}$/;

function toState(error: unknown, what: string): ActionState {
  if (error instanceof FieldError) return { error: error.message };
  console.error(`[admin-panel] ${what} failed`, error);
  return { error: 'Could not save that change. Check the logs.' };
}

async function requireAccount(accountId: string): Promise<{ name: string }> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { name: true },
  });
  if (!account) throw new FieldError('That workspace no longer exists.');
  return account;
}

/** '' means "nobody". Anything else must be an ACTIVE staff member. */
async function staffOrNull(
  formData: FormData,
  name: string,
  label: string
): Promise<{ id: string; name: string } | null> {
  const raw = formData.get(name);
  if (typeof raw !== 'string' || raw === '') return null;
  const id = uuid(formData, name, label);
  const row = await prisma.admin_staff.findUnique({
    where: { id },
    select: { id: true, full_name: true, is_active: true },
  });
  if (!row || !row.is_active) {
    throw new FieldError(`${label} must be an active staff member.`);
  }
  return { id: row.id, name: row.full_name };
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  const tags = [
    ...new Set(
      raw
        .split(',')
        .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, ' '))
        .filter(Boolean)
    ),
  ];
  if (tags.length > MAX_TAGS) {
    throw new FieldError(`At most ${MAX_TAGS} tags.`);
  }
  for (const tag of tags) {
    if (!TAG_RE.test(tag)) {
      throw new FieldError(
        `“${tag}” is not a valid tag — letters, numbers, spaces and hyphens, up to 32 characters.`
      );
    }
  }
  return tags;
}

/* ------------------------------------------------------------
 * Ownership: account manager, backup, support lead, tier, tags
 * ------------------------------------------------------------ */

export async function updateClientOwnership(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('clients.manage');
  if (auth.error) return { error: auth.error };
  const staff = auth.staff;

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const account = await requireAccount(accountId);

    const manager = await staffOrNull(
      formData,
      'accountManagerId',
      'Account manager'
    );
    const backup = await staffOrNull(
      formData,
      'backupManagerId',
      'Backup manager'
    );
    const lead = await staffOrNull(formData, 'supportLeadId', 'Support lead');
    if (manager && backup && manager.id === backup.id) {
      throw new FieldError(
        'The backup manager must be someone other than the account manager.'
      );
    }
    const tier = oneOf(formData, 'serviceTier', TIERS, {
      label: 'Service tier',
    })!;
    const tags = parseTags(optionalText(formData, 'tags'));

    const before = await prisma.client_accounts.findUnique({
      where: { account_id: accountId },
    });

    await prisma.client_accounts.upsert({
      where: { account_id: accountId },
      create: {
        account_id: accountId,
        account_manager_id: manager?.id ?? null,
        backup_manager_id: backup?.id ?? null,
        support_lead_id: lead?.id ?? null,
        service_tier: tier,
        tags,
        updated_by: staff.actor,
      },
      update: {
        account_manager_id: manager?.id ?? null,
        backup_manager_id: backup?.id ?? null,
        support_lead_id: lead?.id ?? null,
        service_tier: tier,
        tags,
        updated_by: staff.actor,
        updated_at: new Date(),
      },
    });

    await recordAudit({
      actor: staff.actor,
      action: 'client.ownership',
      targetType: 'client',
      targetId: accountId,
      accountId,
      summary: `Set ownership of ${account.name}: manager ${manager?.name ?? 'none'}, backup ${backup?.name ?? 'none'}, support lead ${lead?.name ?? 'none'}, ${tier} tier.`,
      detail: {
        before: before
          ? {
              accountManagerId: before.account_manager_id,
              backupManagerId: before.backup_manager_id,
              supportLeadId: before.support_lead_id,
              serviceTier: before.service_tier,
              tags: before.tags,
            }
          : null,
        after: {
          accountManagerId: manager?.id ?? null,
          backupManagerId: backup?.id ?? null,
          supportLeadId: lead?.id ?? null,
          serviceTier: tier,
          tags,
        },
      },
    });

    refresh();
    return { ok: 'Ownership saved.' };
  } catch (error) {
    return toState(error, 'client ownership');
  }
}

/** "Assign to me" — one click from the directory or the 360 header. */
export async function assignToMe(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('clients.manage');
  if (auth.error) return { error: auth.error };
  const staff = auth.staff;
  if (!staff.id) {
    return {
      error: 'The break-glass login is not a person and cannot own a client.',
    };
  }

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const account = await requireAccount(accountId);
    await prisma.client_accounts.upsert({
      where: { account_id: accountId },
      create: {
        account_id: accountId,
        account_manager_id: staff.id,
        updated_by: staff.actor,
      },
      update: {
        account_manager_id: staff.id,
        updated_by: staff.actor,
        updated_at: new Date(),
      },
    });
    await recordAudit({
      actor: staff.actor,
      action: 'client.ownership',
      targetType: 'client',
      targetId: accountId,
      accountId,
      summary: `${staff.name} took ${account.name} as account manager.`,
    });
    refresh();
    return { ok: 'You are now the account manager.' };
  } catch (error) {
    return toState(error, 'assign to me');
  }
}

/* ------------------------------------------------------------
 * Lifecycle pin — a classification, never an enforcement
 * ------------------------------------------------------------ */

export async function setLifecycle(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('clients.manage');
  if (auth.error) return { error: auth.error };
  const staff = auth.staff;

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const account = await requireAccount(accountId);
    // '' = clear the pin and go back to the derived stage.
    const stage = oneOf(formData, 'stage', ['', ...LIFECYCLE_STAGES] as const, {
      label: 'Stage',
      optional: true,
    });
    const reason = text(formData, 'reason', 'Reason');
    if (reason.length > 500)
      throw new FieldError('Keep the reason under 500 characters.');

    const current = await getRosterEntry(accountId);
    const fromStage = current?.lifecycle.stage ?? null;
    const toStage = stage ? stage : null;
    const wasPinned = current?.lifecycle.pinned ?? false;

    if (!toStage && !wasPinned) {
      throw new FieldError(
        'The stage is not pinned — there is nothing to clear.'
      );
    }
    if (toStage && wasPinned && fromStage === toStage) {
      throw new FieldError(`It is already pinned to ${toStage}.`);
    }

    await prisma.$transaction([
      prisma.client_accounts.upsert({
        where: { account_id: accountId },
        create: {
          account_id: accountId,
          lifecycle_override: toStage,
          lifecycle_reason: reason,
          updated_by: staff.actor,
        },
        update: {
          lifecycle_override: toStage,
          lifecycle_reason: toStage ? reason : null,
          updated_by: staff.actor,
          updated_at: new Date(),
        },
      }),
      prisma.client_lifecycle_events.create({
        data: {
          account_id: accountId,
          from_stage: fromStage,
          to_stage: toStage,
          reason,
          actor: staff.actor,
        },
      }),
    ]);

    await recordAudit({
      actor: staff.actor,
      action: toStage ? 'client.lifecycle_pin' : 'client.lifecycle_clear',
      targetType: 'client',
      targetId: accountId,
      accountId,
      summary: toStage
        ? `Pinned ${account.name} to ${toStage} (was ${fromStage ?? 'unknown'}): ${reason}`
        : `Cleared the lifecycle pin on ${account.name}: ${reason}`,
      detail: { fromStage, toStage, reason },
    });

    refresh();
    return {
      ok: toStage
        ? `Pinned to ${toStage}.`
        : 'Pin cleared — the stage is derived again.',
    };
  } catch (error) {
    return toState(error, 'lifecycle');
  }
}

/* ------------------------------------------------------------
 * Notes
 * ------------------------------------------------------------ */

export async function addNote(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('clients.notes');
  if (auth.error) return { error: auth.error };
  const staff = auth.staff;

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const account = await requireAccount(accountId);
    const body = text(formData, 'body', 'Note');
    if (body.length > 4000)
      throw new FieldError('Notes are limited to 4,000 characters.');
    const pinned = boolean(formData, 'pinned');

    const note = await prisma.client_notes.create({
      data: {
        account_id: accountId,
        body,
        pinned,
        author_staff_id: staff.id,
        author: staff.isBreakGlass ? staff.actor : staff.name,
      },
    });

    // The body is not copied into the audit row — notes may hold customer
    // details, and the audit log is readable by more roles than need them.
    await recordAudit({
      actor: staff.actor,
      action: 'client.note',
      targetType: 'client_note',
      targetId: note.id,
      accountId,
      summary: `Added a${pinned ? ' pinned' : ''} note on ${account.name}.`,
    });

    refresh();
    return { ok: 'Note added.' };
  } catch (error) {
    return toState(error, 'note');
  }
}

export async function toggleNotePin(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('clients.notes');
  if (auth.error) return { error: auth.error };
  const staff = auth.staff;

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const noteId = uuid(formData, 'noteId', 'Note');
    // Scoped by BOTH ids: a note id from one client's page must not toggle a
    // note on another's.
    const note = await prisma.client_notes.findFirst({
      where: { id: noteId, account_id: accountId },
      select: { pinned: true },
    });
    if (!note) throw new FieldError('That note no longer exists.');

    await prisma.client_notes.update({
      where: { id: noteId },
      data: { pinned: !note.pinned },
    });
    await recordAudit({
      actor: staff.actor,
      action: note.pinned ? 'client.note_unpin' : 'client.note_pin',
      targetType: 'client_note',
      targetId: noteId,
      accountId,
      summary: note.pinned ? 'Unpinned a note.' : 'Pinned a note.',
    });
    refresh();
    return { ok: note.pinned ? 'Unpinned.' : 'Pinned.' };
  } catch (error) {
    return toState(error, 'note pin');
  }
}

/* ------------------------------------------------------------
 * Follow-up tasks
 * ------------------------------------------------------------ */

export async function addTask(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('clients.notes');
  if (auth.error) return { error: auth.error };
  const staff = auth.staff;

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const account = await requireAccount(accountId);
    const title = text(formData, 'title', 'Task');
    if (title.length > 300)
      throw new FieldError('Keep the task under 300 characters.');
    const dueOn = date(formData, 'dueOn', 'Due date');
    const assignee = await staffOrNull(formData, 'assigneeId', 'Assignee');

    const task = await prisma.client_tasks.create({
      data: {
        account_id: accountId,
        title,
        due_on: dueOn,
        assignee_staff_id: assignee?.id ?? null,
        created_by: staff.actor,
      },
    });

    await recordAudit({
      actor: staff.actor,
      action: 'client.task',
      targetType: 'client_task',
      targetId: task.id,
      accountId,
      summary: `Added a follow-up on ${account.name}: “${title}”${
        assignee ? ` for ${assignee.name}` : ''
      }.`,
    });

    refresh();
    return { ok: 'Task added.' };
  } catch (error) {
    return toState(error, 'task');
  }
}

export async function setTaskStatus(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('clients.notes');
  if (auth.error) return { error: auth.error };
  const staff: Staff = auth.staff;

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const taskId = uuid(formData, 'taskId', 'Task');
    const status = oneOf(formData, 'status', ['open', 'done'] as const, {
      label: 'Status',
    })!;
    const task = await prisma.client_tasks.findFirst({
      where: { id: taskId, account_id: accountId },
      select: { title: true, status: true },
    });
    if (!task) throw new FieldError('That task no longer exists.');
    if (task.status === status) return { ok: 'Already up to date.' };

    await prisma.client_tasks.update({
      where: { id: taskId },
      data:
        status === 'done'
          ? { status, completed_at: new Date(), completed_by: staff.actor }
          : { status, completed_at: null, completed_by: null },
    });
    await recordAudit({
      actor: staff.actor,
      action: status === 'done' ? 'client.task_done' : 'client.task_reopen',
      targetType: 'client_task',
      targetId: taskId,
      accountId,
      summary: `${status === 'done' ? 'Completed' : 'Reopened'} “${task.title}”.`,
    });
    refresh();
    return { ok: status === 'done' ? 'Done.' : 'Reopened.' };
  } catch (error) {
    return toState(error, 'task status');
  }
}
