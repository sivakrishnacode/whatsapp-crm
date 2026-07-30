import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  alertBody,
  isAlertableMessage,
  isUserAway,
  readAlertPreferences,
  shouldPlaySound,
  writeAlertPreference,
  FRESH_WINDOW_MS,
  SOUND_THROTTLE_MS,
} from './message-alerts';
import type { Message } from '@/types';

const NOW = Date.parse('2026-07-30T22:00:00.000Z');

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversation_id: 'c1',
    sender_type: 'customer',
    content_type: 'text',
    content_text: 'Hello there',
    status: 'delivered',
    created_at: new Date(NOW - 1000).toISOString(),
    ...overrides,
  } as Message;
}

describe('isAlertableMessage', () => {
  it('alerts on a fresh customer message', () => {
    expect(isAlertableMessage(msg(), NOW)).toBe(true);
  });

  it('ignores our own outbound messages', () => {
    // Otherwise sending a reply pings the person who just sent it.
    expect(isAlertableMessage(msg({ sender_type: 'agent' }), NOW)).toBe(false);
    expect(isAlertableMessage(msg({ sender_type: 'bot' }), NOW)).toBe(false);
  });

  it('ignores stale inserts replayed after a reconnect', () => {
    // A laptop waking from sleep gets a batch of old inserts; without
    // this, reopening the lid plays the sound for yesterday's messages.
    const stale = msg({
      created_at: new Date(NOW - FRESH_WINDOW_MS - 1).toISOString(),
    });
    expect(isAlertableMessage(stale, NOW)).toBe(false);
  });

  it('accepts a message right at the edge of the window', () => {
    const edge = msg({
      created_at: new Date(NOW - FRESH_WINDOW_MS + 1).toISOString(),
    });
    expect(isAlertableMessage(edge, NOW)).toBe(true);
  });

  it('ignores an unparseable timestamp rather than alerting blindly', () => {
    expect(isAlertableMessage(msg({ created_at: 'not-a-date' }), NOW)).toBe(false);
  });
});

describe('shouldPlaySound', () => {
  it('lets the first sound through', () => {
    expect(shouldPlaySound(0, NOW)).toBe(true);
  });

  it('collapses a burst into one sound', () => {
    expect(shouldPlaySound(NOW, NOW + 100)).toBe(false);
    expect(shouldPlaySound(NOW, NOW + SOUND_THROTTLE_MS - 1)).toBe(false);
  });

  it('allows the next sound once the gap has passed', () => {
    expect(shouldPlaySound(NOW, NOW + SOUND_THROTTLE_MS)).toBe(true);
  });
});

describe('alertBody', () => {
  it('uses the message text, collapsed to one line', () => {
    expect(alertBody({ content_type: 'text', content_text: 'Hi\n\n  there' })).toBe(
      'Hi there',
    );
  });

  it('truncates a long message', () => {
    const body = alertBody({ content_type: 'text', content_text: 'x'.repeat(200) });
    expect(body).toHaveLength(120);
    expect(body.endsWith('…')).toBe(true);
  });

  it('describes media when there is no text', () => {
    expect(alertBody({ content_type: 'image' })).toBe('Sent a photo');
    expect(alertBody({ content_type: 'audio' })).toBe('Sent a voice note');
    expect(alertBody({ content_type: 'location' })).toBe('Shared a location');
    expect(alertBody({ content_type: 'interactive' })).toBe('Sent a message');
  });

  it('treats whitespace-only text as no text', () => {
    expect(alertBody({ content_type: 'document', content_text: '   ' })).toBe(
      'Sent a document',
    );
  });
});

describe('preferences', () => {
  // The suite runs in the `node` environment (vitest.config.ts), so there
  // is no window. A minimal localStorage stub is cheaper than pulling in
  // jsdom for two assertions, and it exercises the same branches.
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('returns safe defaults when there is no window at all (SSR)', () => {
    delete (globalThis as { window?: unknown }).window;
    const prefs = readAlertPreferences();
    expect(prefs.sound).toBe(true);
    expect(prefs.desktop).toBe(false);
    expect(prefs.permission).toBe('unsupported');
  });

  it('defaults to sound on, desktop off', () => {
    // Desktop needs an explicit opt-in because it requires a permission
    // prompt; sound needs none, so it can be on out of the box.
    const prefs = readAlertPreferences();
    expect(prefs.sound).toBe(true);
    expect(prefs.desktop).toBe(false);
    // No Notification API in the test environment
    expect(prefs.permission).toBe('unsupported');
  });

  it('round-trips both toggles', () => {
    writeAlertPreference('sound', false);
    writeAlertPreference('desktop', true);
    const prefs = readAlertPreferences();
    expect(prefs.sound).toBe(false);
    expect(prefs.desktop).toBe(true);

    writeAlertPreference('sound', true);
    expect(readAlertPreferences().sound).toBe(true);
  });
});

describe('isUserAway', () => {
  it('returns true when the tab is hidden', () => {
    expect(isUserAway(true, true)).toBe(true);
    expect(isUserAway(true, false)).toBe(true);
  });

  it('returns true when the page does not have focus', () => {
    // Tab is visible but another app is in front
    expect(isUserAway(false, false)).toBe(true);
  });

  it('returns false only when the tab is visible AND focused', () => {
    expect(isUserAway(false, true)).toBe(false);
  });
});
