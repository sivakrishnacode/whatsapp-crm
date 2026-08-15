import { Injectable, Logger } from '@nestjs/common';

import { ConnectorExecutionService } from '../../connections/services/connector-execution.service';
import type {
  AvailabilityCalendar,
  ExistingBooking,
} from '../slot-engine.util';

/**
 * Google Calendar sync for booking forms.
 *
 * ⚠️ EVERY METHOD HERE IS BEST-EFFORT AND MUST NEVER LOSE A BOOKING.
 *   Google is somebody else's uptime. A revoked token, a `needs_reauth`
 *   connection or a 500 from Calendar all have to degrade to "the booking
 *   happened, the calendar did not get it" — never to a failed booking.
 *   So every method catches its own errors and returns a neutral value:
 *   `busyIntervals` returns nothing to subtract, and the event methods
 *   return null. The one thing they all do is log, because a silent sync
 *   failure is the kind of thing a business discovers by double-booking.
 *
 *   The asymmetry is deliberate and worth stating: failing OPEN on busy
 *   times can offer a slot the owner is busy for, which is a human
 *   apology. Failing CLOSED would offer no times at all, which is a
 *   booking page that silently stops taking bookings — far worse, and
 *   invisible until someone asks why nobody booked this week.
 *
 * ⚠️ `connection_id` comes out of the form's own JSON, so it is data, not
 *   authority. It is only ever used through `ConnectorExecutionService`,
 *   which resolves the token via `getAccessToken({ connectionId,
 *   accountId })` — that query filters `app_connections` by account, and
 *   is what stops one tenant pointing a form at another's calendar.
 */
/**
 * Read a string out of an `unknown` field of somebody else's JSON.
 *
 * Anything that is not already a string becomes `''` rather than
 * `[object Object]`: a malformed value should read as absent, which the
 * callers already handle, instead of becoming a plausible-looking id or
 * an unparseable date.
 */
function asIsoString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

@Injectable()
export class BookingCalendarService {
  private readonly logger = new Logger(BookingCalendarService.name);

  constructor(private readonly connectors: ConnectorExecutionService) {}

  /**
   * The calendar's busy blocks, shaped like bookings.
   *
   * `computeSlots` already subtracts a list of `{startsAt, endsAt}`, so a
   * busy block is just another booking as far as slot maths is concerned —
   * no second code path, and buffers and capacity keep applying unchanged.
   */
  async busyIntervals(args: {
    accountId: string;
    calendar: AvailabilityCalendar;
    from: Date;
    to: Date;
  }): Promise<ExistingBooking[]> {
    const { calendar } = args;
    if (!calendar.block_busy) return [];

    try {
      const result = await this.connectors.run({
        accountId: args.accountId,
        connectionId: calendar.connection_id,
        app: 'google_calendar',
        actionId: 'check_availability',
        // `from`/`to`, not timeMin/timeMax — the action's own field names,
        // which it translates for Google's freeBusy body.
        input: {
          calendar_id: calendar.calendar_id,
          from: args.from.toISOString(),
          to: args.to.toISOString(),
        },
      });

      const busy = (result.output as { busy?: unknown })?.busy;
      if (!Array.isArray(busy)) return [];

      return busy
        .map((b) => {
          const entry = b as { start?: unknown; end?: unknown };
          const startsAt = new Date(asIsoString(entry.start));
          const endsAt = new Date(asIsoString(entry.end));
          return { startsAt, endsAt };
        })
        .filter(
          (b) =>
            !Number.isNaN(b.startsAt.getTime()) &&
            !Number.isNaN(b.endsAt.getTime()) &&
            b.endsAt > b.startsAt,
        );
    } catch (err) {
      // Fails OPEN — see the class comment. An unreachable calendar must
      // not close the booking page.
      this.logger.warn(
        `[booking-calendar] busy lookup failed, offering unfiltered times: ${String(err)}`,
      );
      return [];
    }
  }

  /** Put the booking on the calendar. Returns null if that did not happen. */
  async createEvent(args: {
    accountId: string;
    calendar: AvailabilityCalendar;
    summary: string;
    description?: string;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    /** Invited so the customer gets Google's own invitation and reminders. */
    attendeeEmail?: string | null;
  }): Promise<{ eventId: string | null; meetingUrl: string | null } | null> {
    const { calendar } = args;
    if (!calendar.create_event) return null;

    try {
      const result = await this.connectors.run({
        accountId: args.accountId,
        connectionId: calendar.connection_id,
        app: 'google_calendar',
        actionId: 'create_event',
        input: {
          calendar_id: calendar.calendar_id,
          summary: args.summary,
          description: args.description ?? '',
          start: args.startsAt.toISOString(),
          end: args.endsAt.toISOString(),
          timezone: args.timezone,
          add_meet: calendar.add_meet,
          // The customer gets Google's own invitation and reminders, which
          // is most of the value of syncing at all.
          ...(args.attendeeEmail ? { attendees: args.attendeeEmail } : {}),
        },
      });

      // `meet_link` is what the action declares in `outputs`. Reading a
      // name it does not emit would leave every booking without a link and
      // nothing to show for it.
      const output = result.output as {
        event_id?: unknown;
        meet_link?: unknown;
      };
      return {
        eventId: asIsoString(output?.event_id) || null,
        meetingUrl: asIsoString(output?.meet_link) || null,
      };
    } catch (err) {
      this.logger.error(
        `[booking-calendar] event creation failed; booking stands without it: ${String(err)}`,
      );
      return null;
    }
  }

  /** Move an existing event. Silent no-op when there is nothing to move. */
  async updateEvent(args: {
    accountId: string;
    calendar: AvailabilityCalendar;
    eventId: string | null;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
  }): Promise<void> {
    if (!args.eventId) return;
    try {
      await this.connectors.run({
        accountId: args.accountId,
        connectionId: args.calendar.connection_id,
        app: 'google_calendar',
        actionId: 'update_event',
        input: {
          calendar_id: args.calendar.calendar_id,
          event_id: args.eventId,
          start: args.startsAt.toISOString(),
          end: args.endsAt.toISOString(),
          timezone: args.timezone,
        },
      });
    } catch (err) {
      this.logger.error(
        `[booking-calendar] could not move event ${args.eventId}: ${String(err)}`,
      );
    }
  }

  /** Remove an event after a cancellation. Best-effort, like the rest. */
  async deleteEvent(args: {
    accountId: string;
    calendar: AvailabilityCalendar;
    eventId: string | null;
  }): Promise<void> {
    if (!args.eventId) return;
    try {
      await this.connectors.run({
        accountId: args.accountId,
        connectionId: args.calendar.connection_id,
        app: 'google_calendar',
        actionId: 'delete_event',
        input: {
          calendar_id: args.calendar.calendar_id,
          event_id: args.eventId,
        },
      });
    } catch (err) {
      this.logger.error(
        `[booking-calendar] could not delete event ${args.eventId}: ${String(err)}`,
      );
    }
  }
}
