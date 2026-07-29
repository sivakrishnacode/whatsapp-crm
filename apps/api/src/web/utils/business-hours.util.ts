/**
 * Whether the business is open right now, in ITS timezone.
 *
 * WHY THIS IS A PURE FUNCTION
 *   It decides whether a visitor is offered live chat or an offline form,
 *   and the failure mode is invisible: an off-by-one on the weekday, or
 *   silently evaluating in UTC, means a business in Sydney appears closed
 *   all morning and nobody notices except the customers who leave. Keeping
 *   it free of I/O and of `new Date()` (the instant is a parameter) makes
 *   the timezone and midnight-spanning cases cheap table tests.
 *
 * WHY WINDOWS AND NOT open/close PER DAY
 *   A lunch break is the common case for the SMBs this serves. One
 *   open/close pair per day cannot express 09:00–13:00 and 14:00–18:00, so
 *   a day is a *list* of windows, and a day with no windows is closed.
 */

export interface BusinessHoursWindow {
  /** 0 = Sunday, matching JS `Date.getDay()`. */
  weekday: number;
  /** `HH:mm`, 24-hour, in the schedule's own timezone. */
  start: string;
  end: string;
}

export interface BusinessHours {
  /** IANA zone, e.g. `Asia/Kolkata`. */
  timezone: string;
  windows: BusinessHoursWindow[];
}

/**
 * Shape-validate an untrusted value into a schedule, or null.
 *
 * Returning null for junk means "always open", which is the right failure
 * direction: a malformed schedule that closed the widget would silently
 * cost the customer every conversation.
 */
export function parseBusinessHours(value: unknown): BusinessHours | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const timezone = typeof raw.timezone === 'string' ? raw.timezone : null;
  if (!timezone || !isValidTimeZone(timezone)) return null;

  if (!Array.isArray(raw.windows)) return null;

  const windows: BusinessHoursWindow[] = [];
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
    windows.push({ weekday: w.weekday, start: w.start, end: w.end });
  }

  // A schedule with a valid timezone but no usable windows would mean
  // "closed forever", which is never what someone intended to configure.
  if (windows.length === 0) return null;

  return { timezone, windows };
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function isHhMm(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * The weekday and minute-of-day at `instant`, as observed in `timezone`.
 *
 * Uses `Intl` parts rather than date arithmetic on purpose: it is the only
 * approach that gets DST right without shipping a timezone database, and
 * "add the UTC offset" is wrong twice a year in every zone that observes
 * it.
 */
export function localParts(
  instant: Date,
  timezone: string,
): { weekday: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(instant);
  const lookup = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = weekdayNames.indexOf(lookup('weekday'));

  // `hour12: false` yields '24' for midnight in some ICU versions rather
  // than '00'. Left unnormalised it puts midnight at minute 1440, i.e.
  // outside every window — the business looks closed for one hour a day.
  const hour = Number(lookup('hour')) % 24;
  const minute = Number(lookup('minute'));

  return { weekday, minutes: hour * 60 + minute };
}

/**
 * Is the business open at `instant`?
 *
 * No schedule = always open. A window whose end is at or before its start
 * is treated as spanning midnight (22:00–02:00), because that is the only
 * thing a user can mean by it.
 */
export function isOpenAt(
  hours: BusinessHours | null,
  instant: Date,
): boolean {
  if (!hours) return true;

  const { weekday, minutes } = localParts(instant, hours.timezone);
  if (weekday < 0) return true; // Unparseable — fail open, never closed.

  for (const window of hours.windows) {
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);

    if (end > start) {
      if (window.weekday === weekday && minutes >= start && minutes < end) {
        return true;
      }
      continue;
    }

    // Spans midnight. The window belongs to `weekday` for its
    // before-midnight half and to the NEXT day for the after-midnight
    // half — so a Friday 22:00–02:00 window must still be open at 01:00
    // on Saturday.
    if (window.weekday === weekday && minutes >= start) return true;
    const previousDay = (window.weekday + 1) % 7;
    if (previousDay === weekday && minutes < end) return true;
  }

  return false;
}
