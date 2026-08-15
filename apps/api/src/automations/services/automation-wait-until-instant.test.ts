import { describe, expect, it, vi, afterEach } from 'vitest';

import { AutomationStepExecutorService } from './automation-step-executor.service';
import type {
  AutomationContext,
  WaitUntilStepConfig,
} from '../automation.types';

/**
 * `wait_until` in INSTANT mode — the step that makes "30 minutes before
 * this appointment" possible.
 *
 * Pinned because the failure mode is a reminder that arrives at the wrong
 * time, which nobody notices until a customer misses a meeting. The
 * private method is reached deliberately: it is pure arithmetic over a
 * config and a context, and testing it through the queue would be testing
 * BullMQ.
 */

/**
 * The method is private, so it is reached through a typed view of the
 * prototype rather than `any` — that keeps the arguments checked, which
 * is most of what these tests are asserting.
 */
const proto = AutomationStepExecutorService.prototype as unknown as {
  waitUntilMs: (cfg: WaitUntilStepConfig, context: AutomationContext) => number;
};

// Called as a method on the prototype, so `this` is the prototype — the
// wall-clock branch calls sibling helpers on it.
const waitMs = (cfg: WaitUntilStepConfig, context: AutomationContext): number =>
  proto.waitUntilMs(cfg, context);

const NOW = new Date('2026-08-20T09:00:00.000Z');

function contextWithBooking(startsAt: string): AutomationContext {
  return { vars: { booking: { starts_at: startsAt } } } as AutomationContext;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('wait_until — instant mode', () => {
  it('waits until the offset before the booking', () => {
    vi.useFakeTimers().setSystemTime(NOW);
    // Booking at 11:00, reminder 30 minutes before = 10:30 = 90 minutes away.
    const ms = waitMs(
      { instant: '{{ vars.booking.starts_at }}', offset_minutes: -30 },
      contextWithBooking('2026-08-20T11:00:00.000Z'),
    );
    expect(ms).toBe(90 * 60_000);
  });

  it('treats a positive offset as after', () => {
    vi.useFakeTimers().setSystemTime(NOW);
    const ms = waitMs(
      { instant: '{{ vars.booking.starts_at }}', offset_minutes: 15 },
      contextWithBooking('2026-08-20T10:00:00.000Z'),
    );
    expect(ms).toBe(75 * 60_000);
  });

  it('fires immediately when the moment has already passed', () => {
    // Someone books ten minutes before the slot, so "30 minutes before"
    // is already twenty minutes ago. A late reminder beats none — the
    // message says when the appointment is.
    vi.useFakeTimers().setSystemTime(NOW);
    const ms = waitMs(
      { instant: '{{ vars.booking.starts_at }}', offset_minutes: -30 },
      contextWithBooking('2026-08-20T09:10:00.000Z'),
    );
    expect(ms).toBe(0);
  });

  it('treats a missing offset as zero', () => {
    vi.useFakeTimers().setSystemTime(NOW);
    const ms = waitMs(
      { instant: '{{ vars.booking.starts_at }}' },
      contextWithBooking('2026-08-20T10:00:00.000Z'),
    );
    expect(ms).toBe(60 * 60_000);
  });

  it('throws rather than guessing when the token resolves to nothing', () => {
    // An unknown token interpolates to an empty string. Guessing a delay
    // would fire the reminder at a random time, which is worse than a
    // step that fails visibly in the log.
    expect(() =>
      waitMs(
        { instant: '{{ vars.booking.nope }}', offset_minutes: -30 },
        contextWithBooking('2026-08-20T11:00:00.000Z'),
      ),
    ).toThrow(/could not read/i);
  });

  it('throws on a value that is not a date', () => {
    expect(() =>
      waitMs({ instant: '{{ vars.junk }}' }, {
        vars: { junk: 'tomorrow-ish' },
      } as AutomationContext),
    ).toThrow(/could not read/i);
  });

  it('falls back to wall-clock mode when no instant is set', () => {
    vi.useFakeTimers().setSystemTime(NOW);
    // 09:00 UTC now, waiting until 10:00 UTC — one hour, and nothing to
    // do with any booking.
    const ms = waitMs(
      { time: '10:00', timezone: 'UTC' },
      {} as AutomationContext,
    );
    expect(ms).toBe(60 * 60_000);
  });
});
