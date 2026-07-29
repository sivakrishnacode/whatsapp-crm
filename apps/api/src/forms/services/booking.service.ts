import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import {
  computeSlots,
  isSlotAvailable,
  parseAvailability,
  type Availability,
  type SlotDay,
} from '../slot-engine.util';
import type { FormField } from '../form.types';

export interface BookingJson {
  id: string;
  form_id: string;
  form_name: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: string;
  contact: { id: string; name: string | null; phone: string | null } | null;
  submission_id: string | null;
  notes: string | null;
  created_at: string;
  /** Public reschedule/cancel link. Built here so the UI cannot drift. */
  manage_url: string;
}

/** Postgres exclusion-constraint violation. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * Reserving, rescheduling and cancelling slots.
 *
 * THE RACE IS CLOSED BY THE DATABASE, NOT BY THIS FILE
 *   `isSlotAvailable` runs first, but only to give a friendly "that time just
 *   went" instead of a raw constraint error. It cannot be the guarantee:
 *   between it returning true and the INSERT landing, another request can take
 *   the same slot. `form_bookings_no_overlap` is what actually makes
 *   double-booking impossible, and the `23P01` catch below is what turns it
 *   into a sentence a customer can read.
 *
 *   That ordering matters. Code that only checks and inserts looks correct and
 *   fails under exactly the load that matters — the last slot before a
 *   deadline, two people clicking at once.
 *
 * A BOOKING IS A SUBMISSION PLUS A RESERVATION
 *   The submission already exists by the time this runs (FormSubmitService
 *   created it, ran validation, resolved the contact and fired
 *   `form_submitted`). This adds the row that holds the slot. Confirmations,
 *   reminders and notifications are the automation engine's job via that
 *   trigger — there is deliberately no bespoke messaging path here.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly automationDispatch: AutomationDispatchService,
    private readonly webhookDeliver: WebhookDeliverService,
  ) {}

  /**
   * The `slot_picker` field on a form, if it has one. Its presence is what
   * makes a form a booking form — there is no separate flag to keep in sync.
   */
  static slotField(fields: FormField[]): FormField | null {
    return fields.find((f) => f.type === 'appointment_slot') ?? null;
  }

  /** Offered slots for a published form. */
  async slotsFor(
    formId: string,
    options: { from?: string; to?: string; now?: Date } = {},
  ): Promise<{ timezone: string; days: SlotDay[] }> {
    const form = await this.prisma.forms.findFirst({
      where: { id: formId, status: 'published' },
      select: { id: true, availability: true },
    });
    if (!form) throw new NotFoundException('Booking form not found.');

    const availability = parseAvailability(form.availability);
    if (!availability) {
      // A booking form with no availability configured. Empty rather than an
      // error: the page renders and says "no times available", which is
      // diagnosable, instead of 500ing at a customer.
      return { timezone: 'UTC', days: [] };
    }

    const now = options.now ?? new Date();
    const booked = await this.liveBookings(form.id, now, availability);

    return {
      timezone: availability.timezone,
      days: computeSlots({
        availability,
        booked,
        now,
        fromDate: options.from,
        toDate: options.to,
      }),
    };
  }

  /**
   * Live bookings that could overlap the offered window.
   *
   * Bounded by the window rather than reading the form's whole history: a
   * year-old booking cannot affect next week's slots, and an unbounded read
   * would grow linearly with the form's success.
   */
  private async liveBookings(
    formId: string,
    now: Date,
    availability: Availability,
  ) {
    const horizon = new Date(
      now.getTime() + (availability.window_days + 1) * 86_400_000,
    );
    const rows = await this.prisma.form_bookings.findMany({
      where: {
        form_id: formId,
        status: 'confirmed',
        // A booking starting slightly before `now` can still end after it, so
        // the lower bound reaches back by the longest plausible slot.
        starts_at: {
          gte: new Date(now.getTime() - 24 * 3_600_000),
          lte: horizon,
        },
      },
      select: { starts_at: true, ends_at: true },
    });
    return rows.map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at }));
  }

  /** `liveBookings`, minus one booking — used when rescheduling that one. */
  private async liveBookingsExcluding(
    formId: string,
    excludeId: string,
    now: Date,
    availability: Availability,
  ) {
    const horizon = new Date(
      now.getTime() + (availability.window_days + 1) * 86_400_000,
    );
    const rows = await this.prisma.form_bookings.findMany({
      where: {
        form_id: formId,
        status: 'confirmed',
        id: { not: excludeId },
        starts_at: {
          gte: new Date(now.getTime() - 24 * 3_600_000),
          lte: horizon,
        },
      },
      select: { starts_at: true, ends_at: true },
    });
    return rows.map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at }));
  }

  /**
   * Reserve a slot for a submission that has already been recorded.
   *
   * Called by `FormSubmitService` when the form carries a slot field, so the
   * answers and the reservation cannot get out of step.
   */
  async book(input: {
    accountId: string;
    formId: string;
    submissionId: string;
    contactId: string | null;
    conversationId: string | null;
    /** The chosen instant, already shape-validated by form-validate. */
    startIso: string;
    notes?: string;
    now?: Date;
  }): Promise<BookingJson> {
    const form = await this.prisma.forms.findFirst({
      where: { id: input.formId, account_id: input.accountId },
      select: { id: true, name: true, availability: true, fields: true },
    });
    if (!form) throw new NotFoundException('Booking form not found.');

    const availability = parseAvailability(form.availability);
    if (!availability) {
      throw new BadRequestException(
        'This form is not set up to take bookings yet.',
      );
    }

    const start = new Date(input.startIso);
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('That is not a valid time.');
    }

    const now = input.now ?? new Date();
    const booked = await this.liveBookings(form.id, now, availability);

    // Re-checked server-side. The client picked from a list that may be
    // minutes stale, and this also rejects a hand-crafted off-grid time that
    // the overlap constraint alone would happily accept.
    const available = isSlotAvailable({
      availability,
      booked,
      now,
      start,
    });
    if (!available) {
      throw new ConflictException(
        'That time is no longer available. Please pick another.',
      );
    }

    const end = new Date(start.getTime() + availability.slot_minutes * 60_000);

    try {
      const row = await this.prisma.form_bookings.create({
        data: {
          account_id: input.accountId,
          form_id: form.id,
          submission_id: input.submissionId,
          contact_id: input.contactId,
          conversation_id: input.conversationId,
          starts_at: start,
          ends_at: end,
          timezone: availability.timezone,
          manage_token: generateManageToken(),
          // Denormalised so the EXCLUDE constraint can see it — a constraint
          // cannot join to `forms` to find out.
          capacity_group: availability.capacity > 1,
          notes: input.notes ?? null,
        },
        select: bookingSelect,
      });

      void this.fanOut(input.accountId, row, 'appointment_booked');
      return this.toJson(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === EXCLUSION_VIOLATION
      ) {
        // Someone took it between the check above and this insert. This is
        // the branch that makes the whole design safe, and it is reachable in
        // production far more often than it looks — two people clicking the
        // last slot is the normal case, not an exotic one.
        this.logger.warn(
          `slot ${input.startIso} on form ${form.id} lost a booking race`,
        );
        throw new ConflictException(
          'Someone just took that time. Please pick another.',
        );
      }
      throw err;
    }
  }

  /**
   * Move a booking, by manage token.
   *
   * Same availability re-check and the same race handling as `book` —
   * rescheduling into an occupied slot is exactly as damaging as
   * double-booking into one.
   */
  async reschedule(
    manageToken: string,
    startIso: string,
    now = new Date(),
  ): Promise<BookingJson> {
    const existing = await this.prisma.form_bookings.findUnique({
      where: { manage_token: manageToken },
      select: {
        id: true,
        account_id: true,
        form_id: true,
        status: true,
        starts_at: true,
        forms: { select: { availability: true } },
      },
    });
    if (!existing) throw new NotFoundException('Booking not found.');
    if (existing.status !== 'confirmed') {
      throw new BadRequestException(
        'This booking is no longer active, so it cannot be moved.',
      );
    }

    const availability = parseAvailability(existing.forms.availability);
    if (!availability) {
      throw new BadRequestException('This form no longer takes bookings.');
    }

    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('That is not a valid time.');
    }

    // This booking's OWN slot must not count as a blocker. Without excluding
    // it, rescheduling would refuse any time overlapping where it already is
    // — including nudging a 3:00 to 3:30, which is the most common reason
    // anyone reschedules at all.
    //
    // Excluded by id via a scoped read rather than by comparing instants:
    // with group capacity, two bookings can legitimately share a start, and
    // matching on time would drop somebody else's reservation from the
    // blocker list and let this one overwrite it.
    const blockers = await this.liveBookingsExcluding(
      existing.form_id,
      existing.id,
      now,
      availability,
    );

    if (!isSlotAvailable({ availability, booked: blockers, now, start })) {
      throw new ConflictException(
        'That time is not available. Please pick another.',
      );
    }

    const end = new Date(start.getTime() + availability.slot_minutes * 60_000);

    try {
      const row = await this.prisma.form_bookings.update({
        where: { id: existing.id },
        data: { starts_at: start, ends_at: end, updated_at: new Date() },
        select: bookingSelect,
      });
      void this.fanOut(existing.account_id, row, 'appointment_rescheduled');
      return this.toJson(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === EXCLUSION_VIOLATION
      ) {
        throw new ConflictException(
          'Someone just took that time. Please pick another.',
        );
      }
      throw err;
    }
  }

  /**
   * Cancel, by manage token.
   *
   * Status change rather than a delete: the slot has to stop blocking (the
   * constraint's WHERE clause handles that) while the record of what happened
   * survives, and an automation still needs something to react to.
   */
  async cancel(
    manageToken: string,
    reason?: string,
  ): Promise<BookingJson> {
    const existing = await this.prisma.form_bookings.findUnique({
      where: { manage_token: manageToken },
      select: { id: true, account_id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Booking not found.');
    // Idempotent: a customer clicking a cancel link twice should see
    // "cancelled", not an error.
    if (existing.status === 'cancelled') {
      const row = await this.prisma.form_bookings.findUniqueOrThrow({
        where: { id: existing.id },
        select: bookingSelect,
      });
      return this.toJson(row);
    }

    const row = await this.prisma.form_bookings.update({
      where: { id: existing.id },
      data: {
        status: 'cancelled',
        cancelled_at: new Date(),
        notes: reason ? `Cancelled: ${reason}` : undefined,
        updated_at: new Date(),
      },
      select: bookingSelect,
    });

    void this.fanOut(existing.account_id, row, 'appointment_cancelled');
    return this.toJson(row);
  }

  /** The public view behind a manage token. */
  async findByToken(manageToken: string): Promise<BookingJson> {
    const row = await this.prisma.form_bookings.findUnique({
      where: { manage_token: manageToken },
      select: bookingSelect,
    });
    if (!row) throw new NotFoundException('Booking not found.');
    return this.toJson(row);
  }

  /** The dashboard calendar. */
  async list(
    accountId: string,
    options: { from?: Date; to?: Date; formId?: string } = {},
  ): Promise<BookingJson[]> {
    const rows = await this.prisma.form_bookings.findMany({
      where: {
        account_id: accountId,
        ...(options.formId ? { form_id: options.formId } : {}),
        ...(options.from || options.to
          ? {
              starts_at: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lte: options.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { starts_at: 'asc' },
      take: 500,
      select: bookingSelect,
    });
    return rows.map((row) => this.toJson(row));
  }

  /** Agent-side status change (completed / no-show). */
  async setStatus(
    accountId: string,
    id: string,
    status: 'confirmed' | 'cancelled' | 'completed' | 'no_show',
  ): Promise<BookingJson> {
    const existing = await this.prisma.form_bookings.findFirst({
      where: { id, account_id: accountId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Booking not found.');

    const row = await this.prisma.form_bookings.update({
      where: { id },
      data: {
        status,
        ...(status === 'cancelled' ? { cancelled_at: new Date() } : {}),
        updated_at: new Date(),
      },
      select: bookingSelect,
    });
    if (status === 'cancelled') {
      void this.fanOut(accountId, row, 'appointment_cancelled');
    }
    return this.toJson(row);
  }

  /**
   * Notify the engines. Fire-and-forget: a customer's confirmation page must
   * not wait on an automation, and the booking is already committed.
   */
  private async fanOut(
    accountId: string,
    row: BookingRow,
    triggerType:
      | 'appointment_booked'
      | 'appointment_cancelled'
      | 'appointment_rescheduled',
  ): Promise<void> {
    try {
      await this.automationDispatch.dispatch({
        accountId,
        triggerType,
        contactId: row.contact_id,
        context: {
          form_id: row.form_id,
          appointment_id: row.id,
          // The form id doubles as the "type" for filtering, since a booking
          // form IS the appointment type in this design.
          appointment_type_id: row.form_id,
          conversation_id: row.conversation_id ?? undefined,
          vars: {
            booking: {
              starts_at: row.starts_at.toISOString(),
              ends_at: row.ends_at.toISOString(),
              timezone: row.timezone,
              manage_url: manageUrl(row.manage_token),
            },
          },
        },
      });
    } catch (err) {
      this.logger.error(
        `[automations] ${triggerType} dispatch failed for ${row.id}: ${String(err)}`,
      );
    }

    void this.webhookDeliver.dispatchWebhookEvent(
      accountId,
      triggerType === 'appointment_booked'
        ? 'booking.created'
        : triggerType === 'appointment_cancelled'
          ? 'booking.cancelled'
          : 'booking.rescheduled',
      {
        booking_id: row.id,
        form_id: row.form_id,
        contact_id: row.contact_id,
        starts_at: row.starts_at.toISOString(),
        ends_at: row.ends_at.toISOString(),
        timezone: row.timezone,
        status: row.status,
      },
    );
  }

  private toJson(row: BookingRow): BookingJson {
    return {
      id: row.id,
      form_id: row.form_id,
      form_name: row.forms.name,
      starts_at: row.starts_at.toISOString(),
      ends_at: row.ends_at.toISOString(),
      timezone: row.timezone,
      status: row.status,
      contact: row.contacts
        ? {
            id: row.contacts.id,
            name: row.contacts.name,
            phone: row.contacts.phone,
          }
        : null,
      submission_id: row.submission_id,
      notes: row.notes,
      created_at: row.created_at.toISOString(),
      manage_url: manageUrl(row.manage_token),
    };
  }
}

const bookingSelect = {
  id: true,
  form_id: true,
  submission_id: true,
  contact_id: true,
  conversation_id: true,
  starts_at: true,
  ends_at: true,
  timezone: true,
  status: true,
  manage_token: true,
  notes: true,
  created_at: true,
  forms: { select: { name: true } },
  contacts: { select: { id: true, name: true, phone: true } },
} as const;

interface BookingRow {
  id: string;
  form_id: string;
  submission_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  status: string;
  manage_token: string;
  notes: string | null;
  created_at: Date;
  forms: { name: string };
  contacts: { id: string; name: string | null; phone: string | null } | null;
}

/**
 * 32 bytes. This token IS the authorisation to move or cancel someone's
 * booking, so it has to be unguessable — a short one would let an attacker
 * walk the space and cancel strangers' appointments.
 */
function generateManageToken(): string {
  return randomBytes(32).toString('base64url');
}

function manageUrl(token: string): string {
  const base =
    process.env.PUBLIC_APP_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000';
  return `${base}/book/manage/${token}`;
}
