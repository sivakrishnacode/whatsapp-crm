/**
 * Which times a booking form can actually offer.
 *
 * WHY THIS IS A PURE FUNCTION WITH `now` AS A PARAMETER
 *   It is the whole product. If it offers a slot that is already taken, two
 *   customers turn up at once; if it hides a free one, the business loses a
 *   booking; if it gets a DST transition wrong, an entire country's slots
 *   shift by an hour twice a year. All three failures are silent — nobody
 *   files a bug saying "you offered me 3pm but you were busy", they just
 *   don't come back.
 *
 *   No Prisma, no `new Date()`, no `Intl` beyond zone arithmetic. Every
 *   branch is reachable from a plain object, so the matrix of timezone ×
 *   DST × buffer × booked × notice is table tests rather than fixtures.
 *
 * THE ALGORITHM
 *   For each day in the window: take that weekday's open windows, walk them
 *   in `slot_minutes` steps, and drop a candidate if it is blacked out, too
 *   soon, or overlaps a live booking once buffers are applied. What remains
 *   is offered.
 *
 * ALL ARITHMETIC IS ON ABSOLUTE INSTANTS
 *   The one genuinely hard part. Availability is expressed in wall-clock
 *   ("Mon 09:00–17:00, Europe/London") but bookings are instants, so the two
 *   have to meet. Doing it the other way — converting bookings to wall-clock
 *   and comparing strings — breaks on the DST day when 01:30 happens twice.
 *   So wall-clock is resolved to an instant via a zone-offset probe, and
 *   every comparison after that is numeric.
 */

export interface AvailabilityWindow {
  /** 0 = Sunday, matching JS `Date.getDay()`. */
  weekday: number;
  /** `HH:mm` in the availability's own timezone. */
  start: string;
  end: string;
}

/**
 * Google Calendar sync for a booking form.
 *
 * ⚠️ `connection_id` IS AUTHOR-SUPPLIED DATA, NOT AUTHORITY.
 *   It arrives inside a JSON blob the form's author edited, so every read
 *   of it goes through `ConnectorExecutionService.run({ accountId, ... })`,
 *   whose `getAccessToken` filters `app_connections` by `account_id`.
 *   Same trap as `segment_id` in an automation step config; here the prize
 *   is another tenant's calendar.
 */
export interface AvailabilityCalendar {
  /** `app_connections.id`. Re-scoped to the caller's account on every use. */
  connection_id: string;
  /** Google calendar id. `primary` is the account's own calendar. */
  calendar_id: string;
  /** Subtract the calendar's busy blocks from the offered slots. */
  block_busy: boolean;
  /** Put an event on the calendar when somebody books. */
  create_event: boolean;
  /** Add a Google Meet link to that event. Implies `create_event`. */
  add_meet: boolean;
}

export interface Availability {
  /** IANA zone the windows are expressed in. */
  timezone: string;
  /** Length of one bookable slot. */
  slot_minutes: number;
  /** Dead time reserved after each booking, excluded from what can be booked. */
  buffer_minutes: number;
  /** How soon from `now` a slot may be booked. Stops 2-minutes-from-now bookings. */
  min_notice_minutes: number;
  /** How far ahead to offer. Stops the picker showing next March. */
  window_days: number;
  /** Seats per slot. >1 is a group booking. */
  capacity: number;
  windows: AvailabilityWindow[];
  /** `YYYY-MM-DD` dates that are closed regardless of the weekly pattern. */
  blackout_dates?: string[];
  /** Absent = no calendar sync, which is the default and always valid. */
  calendar?: AvailabilityCalendar;
}

export interface ExistingBooking {
  startsAt: Date;
  endsAt: Date;
}

export interface Slot {
  /** ISO instant. What the client submits back. */
  start: string;
  end: string;
  /** Remaining seats. Always 1 for a non-group form. */
  remaining: number;
}

/** Slots grouped by local date, which is how a picker renders them. */
export interface SlotDay {
  /** `YYYY-MM-DD` in the availability timezone. */
  date: string;
  slots: Slot[];
}

export const DEFAULT_AVAILABILITY: Availability = {
  timezone: 'UTC',
  slot_minutes: 30,
  buffer_minutes: 0,
  min_notice_minutes: 60,
  window_days: 30,
  capacity: 1,
  windows: [],
  blackout_dates: [],
};

/**
 * Shape-validate untrusted availability, or null.
 *
 * Null means "takes no bookings", and the caller offers nothing. That is the
 * safe direction: inventing slots from a malformed config would take
 * bookings the business cannot honour, whereas offering none is visible
 * immediately and fixable.
 */
export function parseAvailability(value: unknown): Availability | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const timezone = typeof raw.timezone === 'string' ? raw.timezone : null;
  if (!timezone || !isValidTimeZone(timezone)) return null;

  const windows: AvailabilityWindow[] = [];
  if (Array.isArray(raw.windows)) {
    for (const entry of raw.windows) {
      if (!entry || typeof entry !== 'object') continue;
      const w = entry as Record<string, unknown>;
      if (
        typeof w.weekday !== 'number' ||
        !Number.isInteger(w.weekday) ||
        w.weekday < 0 ||
        w.weekday > 6
      ) {
        continue;
      }
      if (!isHhMm(w.start) || !isHhMm(w.end)) continue;
      // An end at or before the start is a data-entry error, not an
      // overnight window: nobody takes appointments from 5pm to 9am.
      if (toMinutes(w.start) >= toMinutes(w.end)) continue;
      windows.push({ weekday: w.weekday, start: w.start, end: w.end });
    }
  }

  const calendar = parseCalendar(raw.calendar);

  // A booking form with no open windows offers nothing. Kept as a valid
  // config rather than null so the settings UI can distinguish "not set up
  // yet" from "closed every day" and say so.
  return {
    timezone,
    slot_minutes: clampInt(raw.slot_minutes, 5, 480, 30),
    buffer_minutes: clampInt(raw.buffer_minutes, 0, 240, 0),
    min_notice_minutes: clampInt(raw.min_notice_minutes, 0, 43_200, 60),
    window_days: clampInt(raw.window_days, 1, 365, 30),
    capacity: clampInt(raw.capacity, 1, 1000, 1),
    windows,
    blackout_dates: Array.isArray(raw.blackout_dates)
      ? raw.blackout_dates.filter(
          (d): d is string => typeof d === 'string' && ISO_DATE_RE.test(d),
        )
      : [],
    ...(calendar ? { calendar } : {}),
  };
}

/**
 * Parse the calendar block, or undefined.
 *
 * Undefined rather than null-and-reject: a malformed calendar config must
 * not invalidate the whole availability, because that would take a working
 * booking form offline over a sync setting. The worst case is that sync
 * quietly does not happen, which is visible in the editor and costs
 * nobody their slot.
 */
function parseCalendar(value: unknown): AvailabilityCalendar | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;

  const connectionId =
    typeof raw.connection_id === 'string' ? raw.connection_id.trim() : '';
  if (!connectionId) return undefined;

  const calendarId =
    typeof raw.calendar_id === 'string' && raw.calendar_id.trim()
      ? raw.calendar_id.trim()
      : 'primary';

  const addMeet = raw.add_meet === true;
  return {
    connection_id: connectionId,
    calendar_id: calendarId,
    block_busy: raw.block_busy !== false,
    // A Meet link can only exist on an event, so asking for one is asking
    // for the event too. Storing the contradiction instead would make the
    // UI show a link nobody ever gets.
    create_event: raw.create_event !== false || addMeet,
    add_meet: addMeet,
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
}

function isHhMm(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A zone's UTC offset in minutes at a given instant.
 *
 * Uses `Intl` parts rather than a timezone database: it is the only way to
 * get this right across DST without shipping one, and "add a fixed offset"
 * is wrong twice a year in every zone that observes it.
 */
function offsetMinutesAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  // `hour12: false` renders midnight as '24' in some ICU versions; unhandled
  // that shifts the computed offset by a day.
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Resolve a wall-clock time in a zone to an absolute instant.
 *
 * Two passes, and the second is load-bearing. The offset depends on the
 * instant, and the instant is what we are solving for — so guess with the
 * offset at the naive time, then re-probe at the guess and correct. Without
 * the second pass, every slot within an hour of a DST boundary lands an hour
 * out.
 *
 * On a spring-forward gap (02:30 on a day where 02:00→03:00 never exists)
 * the two passes disagree and this returns the shifted-forward instant. That
 * is the honest answer: the wall-clock time genuinely did not occur, and the
 * alternative — dropping the slot — would silently remove an hour of
 * availability once a year with no way for the business to see why.
 */
export function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timezone: string,
): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, 0, minutes);
  const firstGuess = new Date(
    naiveUtc - offsetMinutesAt(new Date(naiveUtc), timezone) * 60_000,
  );
  const corrected = new Date(
    naiveUtc - offsetMinutesAt(firstGuess, timezone) * 60_000,
  );
  return corrected;
}

/** The `YYYY-MM-DD` / weekday a given instant falls on, in a zone. */
export function localDateParts(
  instant: Date,
  timezone: string,
): { year: number; month: number; day: number; weekday: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    get('weekday'),
  );

  return {
    year,
    month,
    day,
    weekday,
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

export interface ComputeSlotsInput {
  availability: Availability;
  /** Live bookings for this form, any that could overlap the window. */
  booked: ExistingBooking[];
  /** The clock. A parameter so this stays pure and testable. */
  now: Date;
  /** Optional narrowing, e.g. one day the picker is showing. */
  fromDate?: string;
  toDate?: string;
}

/**
 * The offered slots, grouped by local date.
 *
 * Days with nothing available are omitted rather than returned empty: a
 * picker showing fourteen empty days reads as broken, whereas showing the
 * next three days that have anything reads as a calendar.
 */
export function computeSlots(input: ComputeSlotsInput): SlotDay[] {
  const { availability, booked, now } = input;
  const {
    timezone,
    slot_minutes: slotMinutes,
    buffer_minutes: bufferMinutes,
    min_notice_minutes: minNotice,
    window_days: windowDays,
    capacity,
    windows,
  } = availability;

  if (windows.length === 0) return [];

  const blackout = new Set(availability.blackout_dates ?? []);
  const earliest = now.getTime() + minNotice * 60_000;

  // Buffers are applied to the BOOKED interval rather than the candidate, so
  // one subtraction here covers both "no new slot may start inside the
  // buffer after a booking" and "…nor end inside the buffer before one".
  const blockers = booked.map((b) => ({
    start: b.startsAt.getTime() - bufferMinutes * 60_000,
    end: b.endsAt.getTime() + bufferMinutes * 60_000,
    rawStart: b.startsAt.getTime(),
  }));

  const days: SlotDay[] = [];

  for (let dayOffset = 0; dayOffset < windowDays; dayOffset += 1) {
    // Stepped in UTC days then read back in the target zone. Adding 24h
    // repeatedly would drift by an hour across a DST boundary and eventually
    // skip or repeat a local date.
    const probe = new Date(now.getTime() + dayOffset * 86_400_000);
    const local = localDateParts(probe, timezone);

    if (input.fromDate && local.date < input.fromDate) continue;
    if (input.toDate && local.date > input.toDate) break;
    if (blackout.has(local.date)) continue;

    const todaysWindows = windows.filter((w) => w.weekday === local.weekday);
    if (todaysWindows.length === 0) continue;

    const slots: Slot[] = [];

    for (const window of todaysWindows) {
      const windowStart = toMinutes(window.start);
      const windowEnd = toMinutes(window.end);

      for (
        let minute = windowStart;
        minute + slotMinutes <= windowEnd;
        minute += slotMinutes
      ) {
        const start = wallClockToInstant(
          local.year,
          local.month,
          local.day,
          minute,
          timezone,
        );
        const startMs = start.getTime();
        const endMs = startMs + slotMinutes * 60_000;

        // Too soon (or in the past). `min_notice_minutes: 0` still excludes
        // the past, because `earliest` is never behind `now`.
        if (startMs < earliest) continue;

        if (capacity > 1) {
          // Group booking: overlap is expected, so count seats at exactly
          // this start instead of rejecting on overlap. Matching on the raw
          // start (not the buffered interval) is what makes a class of 20
          // fill up rather than the first booking closing the slot.
          const taken = blockers.filter((b) => b.rawStart === startMs).length;
          if (taken >= capacity) continue;
          slots.push({
            start: start.toISOString(),
            end: new Date(endMs).toISOString(),
            remaining: capacity - taken,
          });
          continue;
        }

        const clashes = blockers.some(
          (b) => startMs < b.end && endMs > b.start,
        );
        if (clashes) continue;

        slots.push({
          start: start.toISOString(),
          end: new Date(endMs).toISOString(),
          remaining: 1,
        });
      }
    }

    if (slots.length > 0) {
      // Sorted because multiple windows on one day (a lunch break) are
      // emitted in config order, which need not be chronological.
      slots.sort((a, b) => a.start.localeCompare(b.start));
      days.push({ date: local.date, slots });
    }
  }

  return days;
}

/**
 * Is this exact instant still a slot the form would offer?
 *
 * The server-side re-check on booking. The client picked from a list that may
 * be seconds or minutes stale, and the answer must be recomputed rather than
 * trusted — this is the difference between the overlap constraint being a
 * backstop and being the only thing standing between two customers and the
 * same slot.
 *
 * Note this is not sufficient on its own: between this returning true and the
 * INSERT landing, another request can take the slot. That race is closed by
 * `form_bookings_no_overlap` in the database. This exists to give a clean
 * "that time just went" instead of a constraint-violation error.
 */
export function isSlotAvailable(
  input: ComputeSlotsInput & { start: Date },
): boolean {
  const target = input.start.toISOString();
  const local = localDateParts(input.start, input.availability.timezone);

  // Narrowed to the target's own day: computing the whole window to check one
  // instant would read every booking in the next month on every booking
  // attempt.
  const days = computeSlots({
    ...input,
    fromDate: local.date,
    toDate: local.date,
  });

  return days.some((day) => day.slots.some((slot) => slot.start === target));
}
