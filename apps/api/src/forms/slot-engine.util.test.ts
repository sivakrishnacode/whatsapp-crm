import { describe, expect, it } from 'vitest';

import {
  computeSlots,
  isSlotAvailable,
  localDateParts,
  parseAvailability,
  wallClockToInstant,
  type Availability,
  type ExistingBooking,
} from './slot-engine.util';

function availability(over: Partial<Availability> = {}): Availability {
  return {
    timezone: 'UTC',
    slot_minutes: 30,
    buffer_minutes: 0,
    min_notice_minutes: 0,
    window_days: 7,
    capacity: 1,
    windows: [{ weekday: 3, start: '09:00', end: '11:00' }], // Wednesday
    blackout_dates: [],
    ...over,
  };
}

function booking(startIso: string, minutes = 30): ExistingBooking {
  const startsAt = new Date(startIso);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + minutes * 60_000),
  };
}

/** 2026-07-29 is a Wednesday. Midnight UTC, so the whole day is ahead. */
const WED = new Date('2026-07-29T00:00:00Z');

describe('parseAvailability', () => {
  it('accepts a well-formed config', () => {
    const parsed = parseAvailability({
      timezone: 'Asia/Kolkata',
      slot_minutes: 45,
      buffer_minutes: 15,
      min_notice_minutes: 120,
      window_days: 14,
      capacity: 1,
      windows: [{ weekday: 1, start: '09:00', end: '17:00' }],
    });
    expect(parsed?.slot_minutes).toBe(45);
    expect(parsed?.windows).toHaveLength(1);
  });

  it('returns null for junk — which means "takes no bookings"', () => {
    // Fail-closed on purpose: inventing slots from a malformed config would
    // take bookings the business cannot honour.
    expect(parseAvailability(null)).toBeNull();
    expect(parseAvailability('always')).toBeNull();
    expect(parseAvailability({})).toBeNull();
    expect(parseAvailability({ timezone: 'Mars/Base' })).toBeNull();
  });

  it('clamps absurd numbers instead of erroring', () => {
    const parsed = parseAvailability({
      timezone: 'UTC',
      slot_minutes: 100000,
      buffer_minutes: -5,
      window_days: 9999,
      capacity: 0,
      windows: [],
    });
    expect(parsed?.slot_minutes).toBe(480);
    expect(parsed?.buffer_minutes).toBe(0);
    expect(parsed?.window_days).toBe(365);
    expect(parsed?.capacity).toBe(1);
  });

  it('drops malformed windows, including inverted ones', () => {
    const parsed = parseAvailability({
      timezone: 'UTC',
      windows: [
        { weekday: 1, start: '09:00', end: '17:00' },
        { weekday: 9, start: '09:00', end: '17:00' }, // bad weekday
        { weekday: 2, start: '9:00', end: '17:00' }, // not HH:mm
        // Inverted: a data-entry error, not an overnight window. Nobody
        // takes appointments 17:00 → 09:00.
        { weekday: 3, start: '17:00', end: '09:00' },
        { weekday: 4, start: '10:00', end: '10:00' }, // zero length
      ],
    });
    expect(parsed?.windows).toEqual([
      { weekday: 1, start: '09:00', end: '17:00' },
    ]);
  });

  it('keeps a config with no windows, so the UI can say "closed every day"', () => {
    // Distinct from null ("not a booking form at all").
    const parsed = parseAvailability({ timezone: 'UTC', windows: [] });
    expect(parsed).not.toBeNull();
    expect(parsed?.windows).toEqual([]);
  });

  it('keeps only well-formed blackout dates', () => {
    const parsed = parseAvailability({
      timezone: 'UTC',
      windows: [{ weekday: 1, start: '09:00', end: '10:00' }],
      blackout_dates: ['2026-08-01', 'next tuesday', '01/08/2026'],
    });
    expect(parsed?.blackout_dates).toEqual(['2026-08-01']);
  });
});

describe('wallClockToInstant', () => {
  it('resolves a plain zone', () => {
    // 09:00 IST = 03:30 UTC.
    expect(
      wallClockToInstant(2026, 7, 29, 9 * 60, 'Asia/Kolkata').toISOString(),
    ).toBe('2026-07-29T03:30:00.000Z');
  });

  it('is correct on both sides of a DST boundary', () => {
    // London: BST (UTC+1) in July, GMT (UTC+0) in January. "09:00 local" is a
    // different instant in each — the bug a fixed offset would produce.
    expect(
      wallClockToInstant(2026, 7, 29, 9 * 60, 'Europe/London').toISOString(),
    ).toBe('2026-07-29T08:00:00.000Z');
    expect(
      wallClockToInstant(2026, 1, 28, 9 * 60, 'Europe/London').toISOString(),
    ).toBe('2026-01-28T09:00:00.000Z');
  });

  it('handles a zone with a half-hour offset', () => {
    expect(
      wallClockToInstant(
        2026,
        7,
        29,
        14 * 60 + 30,
        'Asia/Kolkata',
      ).toISOString(),
    ).toBe('2026-07-29T09:00:00.000Z');
  });

  it('resolves a time near the autumn fall-back unambiguously', () => {
    // 2026-10-25 is the UK's fall-back day: 02:00 BST → 01:00 GMT, so 01:30
    // occurs twice. Whichever is returned, it must be a real instant that
    // reads back as 01:30 local — never NaN and never off by a day.
    const instant = wallClockToInstant(2026, 10, 25, 60 + 30, 'Europe/London');
    expect(Number.isNaN(instant.getTime())).toBe(false);
    const back = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(instant);
    expect(back).toBe('01:30');
  });
});

describe('localDateParts', () => {
  it('reads the local date and weekday', () => {
    const parts = localDateParts(new Date('2026-07-29T12:00:00Z'), 'UTC');
    expect(parts.date).toBe('2026-07-29');
    expect(parts.weekday).toBe(3);
  });

  it('rolls to the previous local day where the zone is behind', () => {
    // 02:00 UTC Wednesday is 22:00 Tuesday in New York.
    const parts = localDateParts(
      new Date('2026-07-29T02:00:00Z'),
      'America/New_York',
    );
    expect(parts.date).toBe('2026-07-28');
    expect(parts.weekday).toBe(2);
  });

  it('rolls to the next local day where the zone is ahead', () => {
    // 20:00 UTC Wednesday is 05:00 Thursday in Tokyo.
    const parts = localDateParts(
      new Date('2026-07-29T20:00:00Z'),
      'Asia/Tokyo',
    );
    expect(parts.date).toBe('2026-07-30');
    expect(parts.weekday).toBe(4);
  });
});

describe('computeSlots — the basics', () => {
  it('walks a window in slot-sized steps', () => {
    const days = computeSlots({
      availability: availability(),
      booked: [],
      now: WED,
    });
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe('2026-07-29');
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T09:00:00.000Z',
      '2026-07-29T09:30:00.000Z',
      '2026-07-29T10:00:00.000Z',
      '2026-07-29T10:30:00.000Z',
    ]);
  });

  it('never emits a slot that would run past the window end', () => {
    // 09:00–11:00 in 45-minute slots fits two, not two-and-a-bit.
    const days = computeSlots({
      availability: availability({ slot_minutes: 45 }),
      booked: [],
      now: WED,
    });
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T09:00:00.000Z',
      '2026-07-29T09:45:00.000Z',
    ]);
  });

  it('offers nothing when there are no windows', () => {
    expect(
      computeSlots({
        availability: availability({ windows: [] }),
        booked: [],
        now: WED,
      }),
    ).toEqual([]);
  });

  it('omits days with nothing available rather than returning them empty', () => {
    // A picker showing fourteen empty days reads as broken.
    const days = computeSlots({
      availability: availability({ window_days: 7 }),
      booked: [],
      now: WED,
    });
    expect(days).toHaveLength(1);
  });

  it('sorts across multiple windows on one day', () => {
    // Config order need not be chronological — a lunch break entered
    // afternoon-first must still render in time order.
    const days = computeSlots({
      availability: availability({
        slot_minutes: 60,
        windows: [
          { weekday: 3, start: '14:00', end: '16:00' },
          { weekday: 3, start: '09:00', end: '11:00' },
        ],
      }),
      booked: [],
      now: WED,
    });
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T09:00:00.000Z',
      '2026-07-29T10:00:00.000Z',
      '2026-07-29T14:00:00.000Z',
      '2026-07-29T15:00:00.000Z',
    ]);
  });

  it('spans several days across a week', () => {
    const days = computeSlots({
      availability: availability({
        slot_minutes: 60,
        window_days: 8,
        windows: [
          { weekday: 3, start: '09:00', end: '10:00' },
          { weekday: 5, start: '09:00', end: '10:00' },
        ],
      }),
      booked: [],
      now: WED,
    });
    expect(days.map((d) => d.date)).toEqual([
      '2026-07-29', // Wed
      '2026-07-31', // Fri
      '2026-08-05', // Wed
    ]);
  });
});

describe('computeSlots — existing bookings', () => {
  it('removes a booked slot and keeps its neighbours', () => {
    const days = computeSlots({
      availability: availability(),
      booked: [booking('2026-07-29T09:30:00Z')],
      now: WED,
    });
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T09:00:00.000Z',
      '2026-07-29T10:00:00.000Z',
      '2026-07-29T10:30:00.000Z',
    ]);
  });

  it('allows back-to-back bookings — the half-open bounds', () => {
    // A 09:00–09:30 booking must not block 09:30. Inclusive bounds would
    // reject every adjacent slot and halve real capacity.
    const days = computeSlots({
      availability: availability(),
      booked: [booking('2026-07-29T09:00:00Z')],
      now: WED,
    });
    expect(days[0].slots.map((s) => s.start)).toContain(
      '2026-07-29T09:30:00.000Z',
    );
  });

  it('removes every slot a long booking covers', () => {
    const days = computeSlots({
      availability: availability(),
      booked: [booking('2026-07-29T09:00:00Z', 90)],
      now: WED,
    });
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T10:30:00.000Z',
    ]);
  });

  it('ignores a cancelled-elsewhere booking it was not given', () => {
    // The caller filters to live bookings; this asserts nothing is inferred.
    const days = computeSlots({
      availability: availability(),
      booked: [],
      now: WED,
    });
    expect(days[0].slots).toHaveLength(4);
  });
});

describe('computeSlots — buffers', () => {
  it('blocks the slot after a booking', () => {
    // 15-minute buffer on a 09:00–09:30 booking reaches into 09:30–10:00.
    const days = computeSlots({
      availability: availability({ buffer_minutes: 15 }),
      booked: [booking('2026-07-29T09:00:00Z')],
      now: WED,
    });
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T10:00:00.000Z',
      '2026-07-29T10:30:00.000Z',
    ]);
  });

  it('blocks the slot before a booking too', () => {
    const days = computeSlots({
      availability: availability({ buffer_minutes: 15 }),
      booked: [booking('2026-07-29T10:00:00Z')],
      now: WED,
    });
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T09:00:00.000Z',
    ]);
  });
});

describe('computeSlots — minimum notice', () => {
  it('hides slots that are too soon', () => {
    const days = computeSlots({
      availability: availability({ min_notice_minutes: 120 }),
      // 09:00 local; 2h notice puts the first bookable slot at 11:00, which
      // is past the window's end.
      now: new Date('2026-07-29T09:00:00Z'),
      booked: [],
    });
    expect(days).toEqual([]);
  });

  it('leaves later slots bookable', () => {
    const days = computeSlots({
      availability: availability({ min_notice_minutes: 60 }),
      now: new Date('2026-07-29T09:00:00Z'),
      booked: [],
    });
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T10:00:00.000Z',
      '2026-07-29T10:30:00.000Z',
    ]);
  });

  it('never offers a past slot even with zero notice', () => {
    const days = computeSlots({
      availability: availability({ min_notice_minutes: 0 }),
      now: new Date('2026-07-29T10:00:00Z'),
      booked: [],
    });
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T10:00:00.000Z',
      '2026-07-29T10:30:00.000Z',
    ]);
  });
});

describe('computeSlots — blackout dates', () => {
  it('closes a blacked-out day entirely', () => {
    const days = computeSlots({
      availability: availability({
        window_days: 8,
        windows: [
          { weekday: 3, start: '09:00', end: '10:00' },
          { weekday: 5, start: '09:00', end: '10:00' },
        ],
        blackout_dates: ['2026-07-29'],
      }),
      booked: [],
      now: WED,
    });
    expect(days.map((d) => d.date)).toEqual(['2026-07-31', '2026-08-05']);
  });
});

describe('computeSlots — group capacity', () => {
  it('reports remaining seats and keeps the slot open', () => {
    // Overlap is the point of a group booking, so a first booking must not
    // close the slot.
    const days = computeSlots({
      availability: availability({ capacity: 3 }),
      booked: [booking('2026-07-29T09:00:00Z')],
      now: WED,
    });
    const first = days[0].slots.find(
      (s) => s.start === '2026-07-29T09:00:00.000Z',
    );
    expect(first?.remaining).toBe(2);
  });

  it('closes the slot only when full', () => {
    const days = computeSlots({
      availability: availability({ capacity: 2 }),
      booked: [
        booking('2026-07-29T09:00:00Z'),
        booking('2026-07-29T09:00:00Z'),
      ],
      now: WED,
    });
    expect(days[0].slots.map((s) => s.start)).not.toContain(
      '2026-07-29T09:00:00.000Z',
    );
  });

  it('reports 1 remaining for an ordinary form', () => {
    const days = computeSlots({
      availability: availability(),
      booked: [],
      now: WED,
    });
    expect(days[0].slots.every((s) => s.remaining === 1)).toBe(true);
  });
});

describe('computeSlots — timezones and DST', () => {
  it('emits instants that match the local window in a non-UTC zone', () => {
    // 09:00–11:00 IST on Wednesday = 03:30–05:30 UTC.
    const days = computeSlots({
      availability: availability({
        timezone: 'Asia/Kolkata',
        slot_minutes: 60,
        windows: [{ weekday: 3, start: '09:00', end: '11:00' }],
      }),
      booked: [],
      now: new Date('2026-07-28T20:00:00Z'), // Wed 01:30 IST
    });
    expect(days[0].date).toBe('2026-07-29');
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T03:30:00.000Z',
      '2026-07-29T04:30:00.000Z',
    ]);
  });

  it('holds 09:00 local across a DST change', () => {
    // The headline correctness property: the same config must produce 08:00Z
    // in BST and 09:00Z in GMT. Naive offset arithmetic gets one of them
    // wrong for half the year, shifting every slot by an hour.
    const config = availability({
      timezone: 'Europe/London',
      slot_minutes: 60,
      windows: [{ weekday: 3, start: '09:00', end: '10:00' }],
      window_days: 2,
    });

    const summer = computeSlots({
      availability: config,
      booked: [],
      now: new Date('2026-07-29T00:00:00Z'),
    });
    expect(summer[0].slots[0].start).toBe('2026-07-29T08:00:00.000Z');

    const winter = computeSlots({
      availability: config,
      booked: [],
      now: new Date('2026-01-28T00:00:00Z'),
    });
    expect(winter[0].slots[0].start).toBe('2026-01-28T09:00:00.000Z');
  });

  it('does not skip or duplicate a local date across a DST transition', () => {
    // Stepping by 24h from a fixed instant drifts by an hour over a
    // transition and can repeat or miss a day. 2026-10-25 is the UK
    // fall-back.
    const days = computeSlots({
      availability: availability({
        timezone: 'Europe/London',
        slot_minutes: 60,
        window_days: 5,
        windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          start: '12:00',
          end: '13:00',
        })),
      }),
      booked: [],
      now: new Date('2026-10-23T00:00:00Z'),
    });
    const dates = days.map((d) => d.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
  });

  it('respects a booking made in a different zone from the availability', () => {
    // Bookings are absolute instants, so the zones never have to agree —
    // this asserts the comparison is numeric and not string-based.
    const days = computeSlots({
      availability: availability({
        timezone: 'Asia/Kolkata',
        slot_minutes: 60,
        windows: [{ weekday: 3, start: '09:00', end: '11:00' }],
      }),
      booked: [booking('2026-07-29T03:30:00Z', 60)],
      now: new Date('2026-07-28T20:00:00Z'),
    });
    expect(days[0].slots.map((s) => s.start)).toEqual([
      '2026-07-29T04:30:00.000Z',
    ]);
  });
});

describe('isSlotAvailable', () => {
  const base = { availability: availability(), booked: [], now: WED };

  it('accepts a slot the engine offers', () => {
    expect(
      isSlotAvailable({ ...base, start: new Date('2026-07-29T09:30:00Z') }),
    ).toBe(true);
  });

  it('rejects a slot that does not align with the grid', () => {
    // A hand-crafted request for 09:15 on a 30-minute grid. Without this the
    // overlap constraint would happily accept it and quietly corrupt the
    // schedule.
    expect(
      isSlotAvailable({ ...base, start: new Date('2026-07-29T09:15:00Z') }),
    ).toBe(false);
  });

  it('rejects a slot outside the open window', () => {
    expect(
      isSlotAvailable({ ...base, start: new Date('2026-07-29T14:00:00Z') }),
    ).toBe(false);
  });

  it('rejects a slot on a closed day', () => {
    expect(
      isSlotAvailable({ ...base, start: new Date('2026-07-30T09:00:00Z') }),
    ).toBe(false);
  });

  it('rejects an already-booked slot', () => {
    expect(
      isSlotAvailable({
        ...base,
        booked: [booking('2026-07-29T09:30:00Z')],
        start: new Date('2026-07-29T09:30:00Z'),
      }),
    ).toBe(false);
  });

  it('rejects a slot in the past', () => {
    expect(
      isSlotAvailable({
        ...base,
        now: new Date('2026-07-29T10:00:00Z'),
        start: new Date('2026-07-29T09:00:00Z'),
      }),
    ).toBe(false);
  });

  it('rejects a blacked-out day', () => {
    expect(
      isSlotAvailable({
        ...base,
        availability: availability({ blackout_dates: ['2026-07-29'] }),
        start: new Date('2026-07-29T09:00:00Z'),
      }),
    ).toBe(false);
  });
});
