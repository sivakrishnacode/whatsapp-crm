import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { parseSignedRequest } from './signed-request.util';

/**
 * The signature is the ONLY authorisation on the data-deletion and
 * deauthorize callbacks — there is no session and no bearer token. So a
 * verification bug here means anyone who can guess a Facebook user id can
 * delete that workspace's ad connection.
 */

const SECRET = 'test-app-secret';

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signature = createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');
  return `${signature}.${encodedPayload}`;
}

const VALID = { algorithm: 'HMAC-SHA256', user_id: '1234567890' };

describe('parseSignedRequest', () => {
  it('accepts a correctly signed request', () => {
    const payload = parseSignedRequest(sign(VALID), SECRET);
    expect(payload?.user_id).toBe('1234567890');
  });

  it('rejects a signature made with a different secret', () => {
    expect(parseSignedRequest(sign(VALID, 'wrong-secret'), SECRET)).toBeNull();
  });

  it('rejects a payload tampered with after signing', () => {
    // The attack this exists to stop: swap the user id to delete someone
    // else's connection.
    const signed = sign(VALID);
    const [signature] = signed.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...VALID, user_id: '9999999999' }),
    ).toString('base64url');

    expect(parseSignedRequest(`${signature}.${forged}`, SECRET)).toBeNull();
  });

  it('rejects an unexpected algorithm', () => {
    // Algorithm confusion — the same class of bug as accepting `alg: none`
    // on a JWT. The payload declares its own algorithm, so it cannot be
    // trusted to pick one.
    expect(
      parseSignedRequest(sign({ ...VALID, algorithm: 'none' }), SECRET),
    ).toBeNull();
    expect(
      parseSignedRequest(sign({ ...VALID, algorithm: 'HMAC-SHA1' }), SECRET),
    ).toBeNull();
  });

  it('accepts the algorithm case-insensitively', () => {
    // Meta has sent both casings across versions.
    expect(
      parseSignedRequest(sign({ ...VALID, algorithm: 'hmac-sha256' }), SECRET),
    ).not.toBeNull();
  });

  it('rejects malformed input rather than throwing', () => {
    // These reach a public endpoint, so a throw here would be a 500 on
    // attacker-controlled input.
    for (const bad of [
      '',
      '.',
      'nodot',
      '.onlypayload',
      'onlysignature.',
      'aaaa.not-base64-json',
      `${'a'.repeat(43)}.${Buffer.from('[]').toString('base64url')}`,
    ]) {
      expect(parseSignedRequest(bad, SECRET)).toBeNull();
    }
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on mismatched lengths, so the length check
    // has to come first.
    const encodedPayload = Buffer.from(JSON.stringify(VALID)).toString(
      'base64url',
    );
    expect(parseSignedRequest(`AAAA.${encodedPayload}`, SECRET)).toBeNull();
  });

  it('verifies against the ENCODED payload, not a re-encoding', () => {
    // Meta's base64 of the JSON is what was signed. Re-serialising the
    // parsed object can produce different bytes (key order, whitespace),
    // which would make every real request fail.
    const json = '{"algorithm":"HMAC-SHA256","user_id":"1","extra":  1}';
    const encodedPayload = Buffer.from(json).toString('base64url');
    const signature = createHmac('sha256', SECRET)
      .update(encodedPayload)
      .digest('base64url');

    expect(
      parseSignedRequest(`${signature}.${encodedPayload}`, SECRET)?.user_id,
    ).toBe('1');
  });
});
