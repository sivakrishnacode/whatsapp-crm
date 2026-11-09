/**
 * Support ticket SLA maths (C360-032). Pure — `now` is passed in.
 *
 * The clock is 24×7 and does NOT pause while a ticket waits on the customer.
 * Both are simplifications the desk shows in words next to every clock, so
 * nobody reads a breach as a business-hours breach.
 */

import type { Severity, SlaTarget } from '@/lib/settings';

export const SEVERITIES: Severity[] = ['critical', 'high', 'normal', 'low'];

export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'waiting_customer',
  'escalated',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const OPEN_STATUSES: TicketStatus[] = [
  'open',
  'in_progress',
  'waiting_customer',
  'escalated',
];

export const TICKET_TIERS = ['L1', 'L2', 'L3', 'billing'] as const;
export type TicketTier = (typeof TICKET_TIERS)[number];

export const TICKET_CATEGORIES = [
  'onboarding',
  'meta_channel',
  'messaging',
  'templates',
  'ai',
  'billing',
  'api_integration',
  'account',
  'other',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_SOURCES = [
  'staff',
  'phone',
  'email',
  'whatsapp',
  'monitoring',
  'onboarding',
  'portal',
  'mobile',
] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export function dueDates(
  createdAt: Date,
  target: SlaTarget
): { firstResponseDueAt: Date; resolutionDueAt: Date } {
  return {
    firstResponseDueAt: new Date(
      createdAt.getTime() + target.firstResponseMinutes * 60_000
    ),
    resolutionDueAt: new Date(
      createdAt.getTime() + target.resolutionMinutes * 60_000
    ),
  };
}

export type SlaClock = {
  state: 'met' | 'running' | 'due_soon' | 'breached' | 'none';
  /** Minutes until due (negative once breached). Null when not running. */
  minutesLeft: number | null;
  label: string;
};

function humanMinutes(minutes: number): string {
  const abs = Math.abs(minutes);
  if (abs < 60) return `${abs} min`;
  if (abs < 48 * 60) return `${Math.round(abs / 60)} h`;
  return `${Math.round(abs / (60 * 24))} d`;
}

/**
 * One clock: the first-response clock stops at the first response, the
 * resolution clock at resolution. "Due soon" is the last 20% of the target.
 */
export function clockFor({
  dueAt,
  stoppedAt,
  startedAt,
  now,
}: {
  dueAt: Date | null;
  stoppedAt: Date | null;
  startedAt: Date;
  now: Date;
}): SlaClock {
  if (!dueAt) return { state: 'none', minutesLeft: null, label: 'No SLA' };
  if (stoppedAt) {
    const late = stoppedAt > dueAt;
    return {
      state: late ? 'breached' : 'met',
      minutesLeft: null,
      label: late
        ? `Missed by ${humanMinutes(Math.round((stoppedAt.getTime() - dueAt.getTime()) / 60_000))}`
        : 'Met',
    };
  }
  const left = Math.round((dueAt.getTime() - now.getTime()) / 60_000);
  if (left < 0) {
    return {
      state: 'breached',
      minutesLeft: left,
      label: `Breached ${humanMinutes(left)} ago`,
    };
  }
  const total = Math.max((dueAt.getTime() - startedAt.getTime()) / 60_000, 1);
  return {
    state: left <= total * 0.2 ? 'due_soon' : 'running',
    minutesLeft: left,
    label: `${humanMinutes(left)} left`,
  };
}

/**
 * The clock that matters right now for a ticket: first response until there
 * is one, then resolution.
 */
export function activeClock(
  ticket: {
    status: string;
    created_at: Date;
    first_response_due_at: Date | null;
    first_responded_at: Date | null;
    resolution_due_at: Date | null;
    resolved_at: Date | null;
  },
  now: Date
): { kind: 'first_response' | 'resolution'; clock: SlaClock } {
  if (!ticket.first_responded_at && !ticket.resolved_at) {
    return {
      kind: 'first_response',
      clock: clockFor({
        dueAt: ticket.first_response_due_at,
        stoppedAt: null,
        startedAt: ticket.created_at,
        now,
      }),
    };
  }
  return {
    kind: 'resolution',
    clock: clockFor({
      dueAt: ticket.resolution_due_at,
      stoppedAt: ticket.resolved_at,
      startedAt: ticket.created_at,
      now,
    }),
  };
}
