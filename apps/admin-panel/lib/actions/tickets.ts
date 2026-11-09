'use server';

import { Prisma } from '@prisma/client';
import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';

import { recordAudit } from '@/lib/actions/audit';
import {
  FieldError,
  oneOf,
  optionalText,
  text,
  uuid,
} from '@/lib/actions/parse';
import type { ActionState } from '@/lib/actions/subscriptions';
import { authorizeAction, type Staff } from '@/lib/auth';
import { getAccountHealth } from '@/lib/health/evidence';
import type { HealthKey } from '@/lib/health/rules';
import { prisma } from '@/lib/prisma';
import type { Severity } from '@/lib/settings';
import { getSettings } from '@/lib/settings-store';
import {
  OPEN_STATUSES,
  TICKET_CATEGORIES,
  TICKET_SOURCES,
  TICKET_TIERS,
  dueDates,
  type TicketStatus,
} from '@/lib/sla';

/**
 * Support desk writes (C360-032).
 *
 * Every write lands twice on purpose: a `support_ticket_events` row (the
 * ticket's own change log, append-only, which the detail page renders) and
 * an `admin_audit_log` row (the panel-wide record of who changed what). The
 * event is written in the same transaction as the change it describes; the
 * audit row afterwards and fail-soft, like everywhere else in the panel.
 *
 * Comments are INTERNAL. There is no customer-facing channel for tickets
 * yet, so nothing here notifies a customer, and the UI says so beside every
 * comment box rather than letting staff believe a reply went out.
 */

const SEVERITY_VALUES = ['low', 'normal', 'high', 'critical'] as const;

const HEALTH_KEYS: readonly HealthKey[] = [
  'wa_connection',
  'wa_token',
  'wa_quality',
  'delivery',
  'templates',
  'instagram',
  'web_widget',
  'webhooks',
  'google_bridge',
  'ecommerce',
  'api_keys',
  'ai_credits',
  'billing',
];

function toState(error: unknown, what: string): ActionState {
  if (error instanceof FieldError) return { error: error.message };
  console.error(`[admin-panel] ${what} failed`, error);
  return { error: 'Could not save that change. Check the logs.' };
}

async function event(
  tx: Prisma.TransactionClient,
  input: {
    ticketId: string;
    kind:
      | 'created'
      | 'comment'
      | 'status'
      | 'assign'
      | 'severity'
      | 'tier'
      | 'diagnostic'
      | 'resolution';
    actor: string;
    body?: string | null;
    from?: string | null;
    to?: string | null;
    data?: Record<string, unknown>;
  }
) {
  await tx.support_ticket_events.create({
    data: {
      ticket_id: input.ticketId,
      kind: input.kind,
      actor: input.actor,
      body: input.body ?? null,
      from_value: input.from ?? null,
      to_value: input.to ?? null,
      data: (input.data ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/* ============================================================
 * Create
 * ============================================================ */

/**
 * Resolves the assignee field: '' = nobody, 'me' = the caller, otherwise an
 * active staff id. The break-glass login is not a person and cannot own a
 * ticket.
 */
async function resolveAssignee(
  staff: Staff,
  raw: string | null
): Promise<{ id: string | null; name: string | null }> {
  if (!raw) return { id: null, name: null };
  if (raw === 'me') {
    if (!staff.id) {
      throw new FieldError(
        'The break-glass login cannot own tickets. Leave it unassigned or pick a staff member.'
      );
    }
    return { id: staff.id, name: staff.name };
  }
  const row = await prisma.admin_staff.findUnique({
    where: { id: raw },
    select: { id: true, full_name: true, is_active: true },
  });
  if (!row || !row.is_active) {
    throw new FieldError('That staff member is not active.');
  }
  return { id: row.id, name: row.full_name };
}

export async function createTicket(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('tickets.work');
  if (auth.error) return { error: auth.error };

  let target: string;
  try {
    target = await fileTicket(auth.staff, formData);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return {
        error:
          'Someone opened a ticket for this incident a moment ago. Refresh the incident monitor to find it.',
      };
    }
    return toState(error, 'ticket create');
  }

  // Outside the try: redirect() works by throwing.
  redirect(target);
}

/** Validates, writes the ticket, returns where to go next. */
async function fileTicket(staff: Staff, formData: FormData): Promise<string> {
  const rawAccount = optionalText(formData, 'accountId');
  const accountId = rawAccount ? uuid(formData, 'accountId', 'Client') : null;
  const subject = text(formData, 'subject', 'Subject');
  if (subject.length > 200) {
    throw new FieldError('Keep the subject under 200 characters.');
  }
  const description = optionalText(formData, 'description');
  if (description && description.length > 8000) {
    throw new FieldError('The description is too long (8,000 characters).');
  }
  const category = oneOf(formData, 'category', TICKET_CATEGORIES, {
    label: 'Category',
  })!;
  const severity = oneOf(formData, 'severity', SEVERITY_VALUES, {
    label: 'Severity',
  })! as Severity;
  const tier = oneOf(formData, 'tier', TICKET_TIERS, { label: 'Tier' })!;
  const source = oneOf(formData, 'source', TICKET_SOURCES, {
    label: 'Source',
  })!;
  const requester = optionalText(formData, 'requester');
  const rawIncident = optionalText(formData, 'incident');
  const incidentKey =
    rawIncident && (HEALTH_KEYS as readonly string[]).includes(rawIncident)
      ? (rawIncident as HealthKey)
      : null;
  if (incidentKey && !accountId) {
    throw new FieldError('An incident ticket needs the client it is about.');
  }

  const account = accountId
    ? await prisma.account.findUnique({
        where: { id: accountId },
        select: { id: true, name: true },
      })
    : null;
  if (accountId && !account) {
    throw new FieldError('That client no longer exists.');
  }

  // One open ticket per (client, incident): find it rather than file a
  // second. The partial unique index enforces this anyway; checking first
  // turns the common case into a redirect instead of an error.
  if (incidentKey && accountId) {
    const existing = await prisma.support_tickets.findFirst({
      where: {
        account_id: accountId,
        incident_key: incidentKey,
        status: { notIn: ['resolved', 'closed'] },
      },
      select: { number: true },
    });
    if (existing) return `/support/${Number(existing.number)}?existing=1`;
  }

  const assignee = await resolveAssignee(
    staff,
    optionalText(formData, 'assignee')
  );

  // The diagnostic snapshot is re-read on the SERVER at submission, never
  // taken from the form — what lands on the ticket is what the rules said,
  // not what a browser posted. Evidence sentences never contain secrets
  // (lib/health/evidence.ts selects none).
  let snapshot: Record<string, unknown> | null = null;
  if (incidentKey && accountId) {
    const health = await getAccountHealth(accountId);
    const check = health?.checks.find((c) => c.key === incidentKey);
    if (health && check) {
      snapshot = {
        key: check.key,
        label: check.label,
        category: check.category,
        state: check.state,
        evidence: check.evidence,
        action: check.action,
        checkedAt: check.checkedAt?.toISOString() ?? null,
        evaluatedAt: health.evaluatedAt.toISOString(),
        overall: health.overall,
      };
    }
  }

  const settings = await getSettings();
  const now = new Date();
  const due = dueDates(now, settings.sla[severity]);

  const created = await prisma.$transaction(async (tx) => {
    const ticket = await tx.support_tickets.create({
      data: {
        account_id: accountId,
        account_name: account?.name ?? null,
        subject,
        description,
        source,
        category,
        severity,
        tier,
        status: 'open',
        assignee_staff_id: assignee.id,
        requester,
        incident_key: incidentKey,
        first_response_due_at: due.firstResponseDueAt,
        resolution_due_at: due.resolutionDueAt,
        created_by: staff.actor,
        created_at: now,
        updated_at: now,
      },
      select: { id: true, number: true },
    });
    await event(tx, {
      ticketId: ticket.id,
      kind: 'created',
      actor: staff.actor,
      body: description,
      to: 'open',
      data: { severity, tier, category, source, assignee: assignee.name },
    });
    if (snapshot) {
      await event(tx, {
        ticketId: ticket.id,
        kind: 'diagnostic',
        actor: staff.actor,
        body: `Health snapshot: ${String(snapshot.label)} — ${String(snapshot.state)}`,
        data: snapshot,
      });
    }
    return ticket;
  });

  const number = Number(created.number);
  await recordAudit({
    actor: staff.actor,
    action: 'ticket.create',
    targetType: 'ticket',
    targetId: created.id,
    accountId,
    summary: `Opened SUP-${number} “${subject}”${account ? ` for ${account.name}` : ''} (${severity}, ${tier}).`,
    detail: { number, severity, tier, category, source, incidentKey },
  });
  return `/support/${number}`;
}

/* ============================================================
 * Update — one action, many intents, so each control on the detail
 * page is its own small form posting here.
 * ============================================================ */

const INTENTS = [
  'comment',
  'status',
  'assign',
  'assign_me',
  'severity',
  'escalate',
  'resolve',
  'close',
  'reopen',
] as const;

const SETTABLE_STATUSES = [
  'open',
  'in_progress',
  'waiting_customer',
] as const satisfies readonly TicketStatus[];

const ESCALATION_TIERS = ['L2', 'L3', 'billing', 'L1'] as const;

function isOpen(status: string): boolean {
  return (OPEN_STATUSES as string[]).includes(status);
}

export async function updateTicket(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('tickets.work');
  if (auth.error) return { error: auth.error };
  const { staff } = auth;

  try {
    const ticketId = uuid(formData, 'ticketId', 'Ticket');
    const intent = oneOf(formData, 'intent', INTENTS, { label: 'Action' })!;

    const ticket = await prisma.support_tickets.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new FieldError('That ticket no longer exists.');

    const number = Number(ticket.number);
    const ref = `SUP-${number}`;
    const now = new Date();
    let summary = '';
    let ok = 'Saved.';

    switch (intent) {
      case 'comment': {
        const body = text(formData, 'body', 'Note');
        if (body.length > 8000) {
          throw new FieldError('Keep a note under 8,000 characters.');
        }
        await prisma.$transaction(async (tx) => {
          await tx.support_tickets.update({
            where: { id: ticketId },
            data: {
              // The first staff note is the first response — the
              // first-response clock stops here.
              first_responded_at: ticket.first_responded_at ?? now,
              updated_at: now,
            },
          });
          await event(tx, {
            ticketId,
            kind: 'comment',
            actor: staff.actor,
            body,
          });
        });
        summary = `Added a note to ${ref}.`;
        ok = ticket.first_responded_at
          ? 'Note added.'
          : 'Note added — first response recorded.';
        break;
      }

      case 'status': {
        if (!isOpen(ticket.status)) {
          throw new FieldError(
            'This ticket is resolved or closed. Reopen it first.'
          );
        }
        const to = oneOf(formData, 'status', SETTABLE_STATUSES, {
          label: 'Status',
        })!;
        if (to === ticket.status) throw new FieldError(`It is already ${to}.`);
        await prisma.$transaction(async (tx) => {
          await tx.support_tickets.update({
            where: { id: ticketId },
            data: { status: to, updated_at: now },
          });
          await event(tx, {
            ticketId,
            kind: 'status',
            actor: staff.actor,
            from: ticket.status,
            to,
          });
        });
        summary = `Moved ${ref} from ${ticket.status} to ${to}.`;
        ok = 'Status updated.';
        break;
      }

      case 'assign':
      case 'assign_me': {
        const assignee =
          intent === 'assign_me'
            ? await resolveAssignee(staff, 'me')
            : await resolveAssignee(staff, optionalText(formData, 'assignee'));
        if (assignee.id === ticket.assignee_staff_id) {
          throw new FieldError('That is already the assignee.');
        }
        const previous = ticket.assignee_staff_id
          ? await prisma.admin_staff.findUnique({
              where: { id: ticket.assignee_staff_id },
              select: { full_name: true },
            })
          : null;
        await prisma.$transaction(async (tx) => {
          await tx.support_tickets.update({
            where: { id: ticketId },
            data: { assignee_staff_id: assignee.id, updated_at: now },
          });
          await event(tx, {
            ticketId,
            kind: 'assign',
            actor: staff.actor,
            from: previous?.full_name ?? null,
            to: assignee.name,
          });
        });
        summary = assignee.name
          ? `Assigned ${ref} to ${assignee.name}.`
          : `Unassigned ${ref}.`;
        ok = assignee.name ? `Assigned to ${assignee.name}.` : 'Unassigned.';
        break;
      }

      case 'severity': {
        const to = oneOf(formData, 'severity', SEVERITY_VALUES, {
          label: 'Severity',
        })! as Severity;
        if (to === ticket.severity) {
          throw new FieldError(`It is already ${to}.`);
        }
        // Targets are re-derived from CREATION time under the new severity,
        // not from now: raising a 3-day-old ticket to critical makes it
        // breached at once, which is exactly what it is.
        const settings = await getSettings();
        const due = dueDates(ticket.created_at, settings.sla[to]);
        await prisma.$transaction(async (tx) => {
          await tx.support_tickets.update({
            where: { id: ticketId },
            data: {
              severity: to,
              first_response_due_at: due.firstResponseDueAt,
              resolution_due_at: due.resolutionDueAt,
              updated_at: now,
            },
          });
          await event(tx, {
            ticketId,
            kind: 'severity',
            actor: staff.actor,
            from: ticket.severity,
            to,
          });
        });
        summary = `Changed ${ref} severity from ${ticket.severity} to ${to}; SLA targets recomputed.`;
        ok =
          'Severity changed — SLA due times recomputed from when the ticket was opened.';
        break;
      }

      case 'escalate': {
        if (!isOpen(ticket.status)) {
          throw new FieldError('Reopen the ticket before escalating it.');
        }
        const tier = oneOf(formData, 'tier', ESCALATION_TIERS, {
          label: 'Tier',
        })!;
        const note = optionalText(formData, 'note');
        if (tier === ticket.tier && ticket.status === 'escalated') {
          throw new FieldError(`It is already escalated to ${tier}.`);
        }
        // Moving back to L1 is a reassignment, not an escalation.
        const toStatus = tier === 'L1' ? ticket.status : 'escalated';
        await prisma.$transaction(async (tx) => {
          await tx.support_tickets.update({
            where: { id: ticketId },
            data: { tier, status: toStatus, updated_at: now },
          });
          await event(tx, {
            ticketId,
            kind: 'tier',
            actor: staff.actor,
            from: ticket.tier,
            to: tier,
            body: note,
          });
          if (toStatus !== ticket.status) {
            await event(tx, {
              ticketId,
              kind: 'status',
              actor: staff.actor,
              from: ticket.status,
              to: toStatus,
            });
          }
        });
        summary = `Moved ${ref} from ${ticket.tier} to ${tier}${toStatus === 'escalated' ? ' (escalated)' : ''}.`;
        ok = tier === 'L1' ? 'Moved to L1.' : `Escalated to ${tier}.`;
        break;
      }

      case 'resolve': {
        if (!isOpen(ticket.status)) {
          throw new FieldError('This ticket is already resolved or closed.');
        }
        const resolution = text(formData, 'resolution', 'Resolution');
        if (resolution.length > 8000) {
          throw new FieldError('Keep the resolution under 8,000 characters.');
        }
        await prisma.$transaction(async (tx) => {
          await tx.support_tickets.update({
            where: { id: ticketId },
            data: {
              status: 'resolved',
              resolution,
              resolved_at: now,
              // Resolving is a response too.
              first_responded_at: ticket.first_responded_at ?? now,
              updated_at: now,
            },
          });
          await event(tx, {
            ticketId,
            kind: 'resolution',
            actor: staff.actor,
            body: resolution,
            from: ticket.status,
            to: 'resolved',
          });
        });
        summary = `Resolved ${ref}.`;
        ok = 'Resolved.';
        break;
      }

      case 'close': {
        if (ticket.status !== 'resolved') {
          throw new FieldError(
            'Resolve it first — a closed ticket needs a recorded resolution.'
          );
        }
        await prisma.$transaction(async (tx) => {
          await tx.support_tickets.update({
            where: { id: ticketId },
            data: { status: 'closed', closed_at: now, updated_at: now },
          });
          await event(tx, {
            ticketId,
            kind: 'status',
            actor: staff.actor,
            from: 'resolved',
            to: 'closed',
          });
        });
        summary = `Closed ${ref}.`;
        ok = 'Closed.';
        break;
      }

      case 'reopen': {
        if (isOpen(ticket.status)) {
          throw new FieldError('This ticket is already open.');
        }
        const reason = text(formData, 'reason', 'Reason for reopening');
        await prisma.$transaction(async (tx) => {
          await tx.support_tickets.update({
            where: { id: ticketId },
            data: {
              status: 'open',
              // The resolution clock runs again from its original due time;
              // the previous resolution text stays on the event log.
              resolved_at: null,
              closed_at: null,
              updated_at: now,
            },
          });
          await event(tx, {
            ticketId,
            kind: 'status',
            actor: staff.actor,
            from: ticket.status,
            to: 'open',
            body: reason,
          });
        });
        summary = `Reopened ${ref}: ${reason}`;
        ok = 'Reopened.';
        break;
      }
    }

    await recordAudit({
      actor: staff.actor,
      action: `ticket.${intent}`,
      targetType: 'ticket',
      targetId: ticketId,
      accountId: ticket.account_id,
      summary,
      detail: { number },
    });

    refresh();
    return { ok };
  } catch (error) {
    return toState(error, 'ticket update');
  }
}
