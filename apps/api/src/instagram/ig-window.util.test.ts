import { describe, it, expect } from 'vitest';
import {
  evaluateSendWindow,
  windowRemainingMs,
  IG_STANDARD_WINDOW_MS,
  IG_HUMAN_AGENT_WINDOW_MS,
} from './ig-window.util';

const NOW = new Date('2026-07-28T12:00:00.000Z');

/** `hours` before NOW. */
function ago(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

describe('evaluateSendWindow', () => {
  it('refuses when the customer has never messaged', () => {
    const result = evaluateSendWindow({
      lastInboundAt: null,
      humanAgentEnabled: false,
      now: NOW,
    });
    expect(result).toMatchObject({ allowed: false, code: 'no_inbound' });
  });

  it('refuses a never-messaged thread even with Human Agent enabled', () => {
    // Human Agent extends an existing window; it does not create one.
    // Getting this wrong would let the CRM cold-DM strangers.
    const result = evaluateSendWindow({
      lastInboundAt: null,
      humanAgentEnabled: true,
      now: NOW,
    });
    expect(result).toMatchObject({ allowed: false, code: 'no_inbound' });
  });

  it('allows an untagged reply inside 24 hours', () => {
    const result = evaluateSendWindow({
      lastInboundAt: ago(1),
      humanAgentEnabled: false,
      now: NOW,
    });
    expect(result).toEqual({ allowed: true, requiresTag: null });
  });

  it('allows an untagged reply one millisecond before the 24h boundary', () => {
    const result = evaluateSendWindow({
      lastInboundAt: new Date(NOW.getTime() - IG_STANDARD_WINDOW_MS + 1),
      humanAgentEnabled: false,
      now: NOW,
    });
    expect(result).toEqual({ allowed: true, requiresTag: null });
  });

  it('closes exactly at 24 hours, not after', () => {
    const result = evaluateSendWindow({
      lastInboundAt: new Date(NOW.getTime() - IG_STANDARD_WINDOW_MS),
      humanAgentEnabled: false,
      now: NOW,
    });
    expect(result).toMatchObject({ allowed: false, code: 'window_closed' });
  });

  it('refuses past 24h when Human Agent is not approved', () => {
    const result = evaluateSendWindow({
      lastInboundAt: ago(30),
      humanAgentEnabled: false,
      now: NOW,
    });
    expect(result).toMatchObject({ allowed: false, code: 'window_closed' });
    // The reason has to explain WHY there is no workaround, since a
    // WhatsApp-trained user will reach for a template.
    if (!result.allowed) {
      expect(result.reason).toMatch(/no message templates/i);
    }
  });

  it('requires the HUMAN_AGENT tag between 24h and 7d when approved', () => {
    const result = evaluateSendWindow({
      lastInboundAt: ago(30),
      humanAgentEnabled: true,
      now: NOW,
    });
    expect(result).toEqual({ allowed: true, requiresTag: 'HUMAN_AGENT' });
  });

  it('closes exactly at 7 days even with Human Agent', () => {
    const result = evaluateSendWindow({
      lastInboundAt: new Date(NOW.getTime() - IG_HUMAN_AGENT_WINDOW_MS),
      humanAgentEnabled: true,
      now: NOW,
    });
    expect(result).toMatchObject({
      allowed: false,
      code: 'human_agent_window_closed',
    });
  });

  it('refuses past 7 days with Human Agent enabled', () => {
    const result = evaluateSendWindow({
      lastInboundAt: ago(24 * 8),
      humanAgentEnabled: true,
      now: NOW,
    });
    expect(result).toMatchObject({
      allowed: false,
      code: 'human_agent_window_closed',
    });
  });

  it('treats a future timestamp as inside the window', () => {
    // Clock skew or a bad backfill. Refusing a send that is almost
    // certainly legitimate is the worse failure of the two.
    const result = evaluateSendWindow({
      lastInboundAt: new Date(NOW.getTime() + 60_000),
      humanAgentEnabled: false,
      now: NOW,
    });
    expect(result).toEqual({ allowed: true, requiresTag: null });
  });
});

describe('windowRemainingMs', () => {
  it('is null when no window was ever opened', () => {
    expect(
      windowRemainingMs({
        lastInboundAt: null,
        humanAgentEnabled: false,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('counts down the 24h window', () => {
    expect(
      windowRemainingMs({
        lastInboundAt: ago(4),
        humanAgentEnabled: false,
        now: NOW,
      }),
    ).toBe(20 * 3_600_000);
  });

  it('counts down the 7-day window when Human Agent is enabled', () => {
    expect(
      windowRemainingMs({
        lastInboundAt: ago(24),
        humanAgentEnabled: true,
        now: NOW,
      }),
    ).toBe(IG_HUMAN_AGENT_WINDOW_MS - 24 * 3_600_000);
  });

  it('clamps to zero rather than going negative', () => {
    // The UI renders this directly; a negative countdown would display
    // as a nonsense duration.
    expect(
      windowRemainingMs({
        lastInboundAt: ago(48),
        humanAgentEnabled: false,
        now: NOW,
      }),
    ).toBe(0);
  });
});
