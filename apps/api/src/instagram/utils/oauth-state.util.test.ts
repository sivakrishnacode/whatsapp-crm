import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encodeOAuthState, decodeOAuthState } from './oauth-state.util';

const PAYLOAD = {
  accountId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
};

describe('OAuth state', () => {
  const original = process.env.INSTAGRAM_APP_SECRET;

  beforeEach(() => {
    process.env.INSTAGRAM_APP_SECRET = 'test-app-secret';
  });

  afterEach(() => {
    process.env.INSTAGRAM_APP_SECRET = original;
    vi.useRealTimers();
  });

  it('round-trips the account binding', () => {
    const decoded = decodeOAuthState(encodeOAuthState(PAYLOAD));
    expect(decoded).toMatchObject(PAYLOAD);
  });

  it('preserves returnTo', () => {
    const decoded = decodeOAuthState(
      encodeOAuthState({
        ...PAYLOAD,
        returnTo: '/channels/instagram/settings',
      }),
    );
    expect(decoded?.returnTo).toBe('/channels/instagram/settings');
  });

  it('produces a different state each time', () => {
    // The nonce is what stops a captured state from being replayed
    // against a second victim.
    expect(encodeOAuthState(PAYLOAD)).not.toBe(encodeOAuthState(PAYLOAD));
  });

  it('rejects a state whose payload was swapped for another account', () => {
    // The attack this exists to stop: re-point a legitimate connect flow
    // at a different tenant so the Instagram account attaches there.
    const state = encodeOAuthState(PAYLOAD);
    const [body, signature] = state.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    decoded.accountId = '33333333-3333-4333-8333-333333333333';
    const forgedBody = Buffer.from(JSON.stringify(decoded)).toString(
      'base64url',
    );

    expect(decodeOAuthState(`${forgedBody}.${signature}`)).toBeNull();
  });

  it('rejects a state signed with a different secret', () => {
    const state = encodeOAuthState(PAYLOAD);
    process.env.INSTAGRAM_APP_SECRET = 'a-completely-different-secret';
    expect(decodeOAuthState(state)).toBeNull();
  });

  it('rejects an expired state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
    const state = encodeOAuthState(PAYLOAD);

    // TTL is 10 minutes — a consent dialog, not a session.
    vi.setSystemTime(new Date('2026-07-28T12:11:00.000Z'));
    expect(decodeOAuthState(state)).toBeNull();
  });

  it('accepts a state just inside the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
    const state = encodeOAuthState(PAYLOAD);

    vi.setSystemTime(new Date('2026-07-28T12:09:00.000Z'));
    expect(decodeOAuthState(state)).toMatchObject(PAYLOAD);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '.', 'nodot', 'a.b', '....', 'x'.repeat(500)]) {
      expect(() => decodeOAuthState(bad)).not.toThrow();
      expect(decodeOAuthState(bad)).toBeNull();
    }
  });

  it('fails closed when the signing secret is missing', () => {
    const state = encodeOAuthState(PAYLOAD);
    delete process.env.INSTAGRAM_APP_SECRET;
    expect(decodeOAuthState(state)).toBeNull();
  });
});
