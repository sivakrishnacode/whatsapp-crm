import { describe, expect, it } from 'vitest';

import {
  isOpenAt,
  localParts,
  parseBusinessHours,
  type BusinessHours,
} from './business-hours.util';

/** Mon–Fri 09:00–17:00 in Kolkata (UTC+5:30, no DST). */
const KOLKATA_WEEKDAYS: BusinessHours = {
  timezone: 'Asia/Kolkata',
  windows: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    start: '09:00',
    end: '17:00',
  })),
};

describe('parseBusinessHours', () => {
  it('accepts a well-formed schedule', () => {
    expect(
      parseBusinessHours({
        timezone: 'Asia/Kolkata',
        windows: [{ weekday: 1, start: '09:00', end: '17:00' }],
      }),
    ).toEqual({
      timezone: 'Asia/Kolkata',
      windows: [{ weekday: 1, start: '09:00', end: '17:00' }],
    });
  });

  it('keeps several windows on one day — the lunch-break case', () => {
    const parsed = parseBusinessHours({
      timezone: 'Europe/London',
      windows: [
        { weekday: 1, start: '09:00', end: '13:00' },
        { weekday: 1, start: '14:00', end: '18:00' },
      ],
    });
    expect(parsed?.windows).toHaveLength(2);
  });

  it('returns null for junk, which means always open', () => {
    // Fail-open is the deliberate direction: a malformed schedule that
    // closed the widget would silently cost every conversation.
    expect(parseBusinessHours(null)).toBeNull();
    expect(parseBusinessHours(undefined)).toBeNull();
    expect(parseBusinessHours('always')).toBeNull();
    expect(parseBusinessHours({})).toBeNull();
    expect(parseBusinessHours({ timezone: 'Asia/Kolkata' })).toBeNull();
    expect(parseBusinessHours({ windows: [] })).toBeNull();
  });

  it('rejects an invalid timezone rather than guessing UTC', () => {
    expect(
      parseBusinessHours({
        timezone: 'Mars/Olympus_Mons',
        windows: [{ weekday: 1, start: '09:00', end: '17:00' }],
      }),
    ).toBeNull();
  });

  it('drops malformed windows and keeps the rest', () => {
    const parsed = parseBusinessHours({
      timezone: 'UTC',
      windows: [
        { weekday: 1, start: '09:00', end: '17:00' },
        { weekday: 7, start: '09:00', end: '17:00' }, // out of range
        { weekday: 2, start: '9:00', end: '17:00' }, // not HH:mm
        { weekday: 3, start: '25:00', end: '26:00' }, // impossible
        'nonsense',
      ],
    });
    expect(parsed?.windows).toEqual([
      { weekday: 1, start: '09:00', end: '17:00' },
    ]);
  });

  it('returns null when every window is unusable — never "closed forever"', () => {
    expect(
      parseBusinessHours({ timezone: 'UTC', windows: [{ weekday: 9 }] }),
    ).toBeNull();
  });
});

describe('localParts', () => {
  it('reads the weekday and minute-of-day in the target zone', () => {
    // 2026-07-29 is a Wednesday. 06:30 UTC is 12:00 in Kolkata.
    const { weekday, minutes } = localParts(
      new Date('2026-07-29T06:30:00Z'),
      'Asia/Kolkata',
    );
    expect(weekday).toBe(3);
    expect(minutes).toBe(12 * 60);
  });

  it('puts midnight at minute 0, not 1440', () => {
    // Some ICU versions render midnight as '24' under hour12: false.
    // Unnormalised, that lands outside every window and the business
    // looks closed for an hour a day.
    const { minutes } = localParts(
      new Date('2026-07-29T00:00:00Z'),
      'UTC',
    );
    expect(minutes).toBe(0);
  });

  it('crosses the date line into the previous weekday', () => {
    // 02:00 UTC Wednesday is 22:00 Tuesday in New York — EDT (UTC-4) in
    // July, not EST. Getting this wrong in the other direction is exactly
    // the class of bug isOpenAt's DST test guards against.
    const { weekday, minutes } = localParts(
      new Date('2026-07-29T02:00:00Z'),
      'America/New_York',
    );
    expect(weekday).toBe(2);
    expect(minutes).toBe(22 * 60);
  });
});

describe('isOpenAt', () => {
  it('is always open with no schedule', () => {
    expect(isOpenAt(null, new Date('2026-07-29T03:00:00Z'))).toBe(true);
  });

  it('opens and closes on the boundary the way a human expects', () => {
    // 09:00 IST = 03:30 UTC, 17:00 IST = 11:30 UTC, on a Wednesday.
    expect(
      isOpenAt(KOLKATA_WEEKDAYS, new Date('2026-07-29T03:30:00Z')),
    ).toBe(true); // exactly 09:00 — open
    expect(
      isOpenAt(KOLKATA_WEEKDAYS, new Date('2026-07-29T03:29:00Z')),
    ).toBe(false); // 08:59
    expect(
      isOpenAt(KOLKATA_WEEKDAYS, new Date('2026-07-29T11:29:00Z')),
    ).toBe(true); // 16:59
    expect(
      isOpenAt(KOLKATA_WEEKDAYS, new Date('2026-07-29T11:30:00Z')),
    ).toBe(false); // exactly 17:00 — closed
  });

  it('evaluates in the business timezone, not UTC', () => {
    // 23:00 UTC Tuesday is 04:30 Wednesday in Kolkata — before opening.
    // Read as UTC it would be Tuesday 23:00, also closed, so use a time
    // where the two answers differ: 04:00 UTC Wednesday is 09:30 IST
    // (open) but 04:00 UTC alone is outside 09:00–17:00.
    expect(
      isOpenAt(KOLKATA_WEEKDAYS, new Date('2026-07-29T04:00:00Z')),
    ).toBe(true);
  });

  it('is closed on a day with no windows', () => {
    // 2026-08-01 is a Saturday.
    expect(
      isOpenAt(KOLKATA_WEEKDAYS, new Date('2026-08-01T06:00:00Z')),
    ).toBe(false);
  });

  it('honours a lunch break', () => {
    const split: BusinessHours = {
      timezone: 'UTC',
      windows: [
        { weekday: 3, start: '09:00', end: '13:00' },
        { weekday: 3, start: '14:00', end: '18:00' },
      ],
    };
    expect(isOpenAt(split, new Date('2026-07-29T12:00:00Z'))).toBe(true);
    expect(isOpenAt(split, new Date('2026-07-29T13:30:00Z'))).toBe(false);
    expect(isOpenAt(split, new Date('2026-07-29T15:00:00Z'))).toBe(true);
  });

  it('handles a window that spans midnight, on both sides', () => {
    // Wednesday 22:00 → 02:00 Thursday.
    const overnight: BusinessHours = {
      timezone: 'UTC',
      windows: [{ weekday: 3, start: '22:00', end: '02:00' }],
    };
    expect(isOpenAt(overnight, new Date('2026-07-29T23:00:00Z'))).toBe(true);
    // 01:00 on Thursday still belongs to Wednesday's window.
    expect(isOpenAt(overnight, new Date('2026-07-30T01:00:00Z'))).toBe(true);
    expect(isOpenAt(overnight, new Date('2026-07-30T03:00:00Z'))).toBe(false);
    expect(isOpenAt(overnight, new Date('2026-07-29T21:00:00Z'))).toBe(false);
  });

  it('gets DST right on both sides of a transition', () => {
    // London: BST (UTC+1) in July, GMT (UTC+0) in January. A schedule of
    // 09:00–17:00 local must hold in both, which naive offset arithmetic
    // gets wrong for half the year.
    const london: BusinessHours = {
      timezone: 'Europe/London',
      windows: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        start: '09:00',
        end: '17:00',
      })),
    };

    // 08:30 UTC in July = 09:30 BST — open.
    expect(isOpenAt(london, new Date('2026-07-29T08:30:00Z'))).toBe(true);
    // 08:30 UTC in January = 08:30 GMT — still closed.
    expect(isOpenAt(london, new Date('2026-01-28T08:30:00Z'))).toBe(false);
    // 09:30 UTC in January = 09:30 GMT — open.
    expect(isOpenAt(london, new Date('2026-01-28T09:30:00Z'))).toBe(true);
    // 16:30 UTC in July = 17:30 BST — closed.
    expect(isOpenAt(london, new Date('2026-07-29T16:30:00Z'))).toBe(false);
  });

  it('fails open when the weekday cannot be determined', () => {
    // Defensive: an unparseable instant must never present as "closed".
    expect(
      isOpenAt(
        { timezone: 'Asia/Kolkata', windows: [] },
        new Date('2026-07-29T06:00:00Z'),
      ),
    ).toBe(false);
  });
});
