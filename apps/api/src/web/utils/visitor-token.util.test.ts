import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

import {
  VisitorTokenError,
  generateVisitorId,
  signVisitorToken,
  verifyVisitorToken,
  type VisitorTokenClaims,
} from './visitor-token.util';

const SECRET_A = 'account-a-secret-that-is-long-enough-for-hs256-signing';
const SECRET_B = 'account-b-secret-that-is-long-enough-for-hs256-signing';

const CLAIMS: VisitorTokenClaims = {
  accountId: '11111111-1111-1111-1111-111111111111',
  visitorId: '22222222-2222-2222-2222-222222222222',
  conversationId: '33333333-3333-3333-3333-333333333333',
  contactId: '44444444-4444-4444-4444-444444444444',
};

describe('signVisitorToken / verifyVisitorToken', () => {
  it('round-trips every claim', async () => {
    const token = await signVisitorToken(CLAIMS, SECRET_A);
    expect(await verifyVisitorToken(token, SECRET_A)).toEqual(CLAIMS);
  });

  it('carries a verified identity when present, and omits it otherwise', async () => {
    const withIdentity = await signVisitorToken(
      { ...CLAIMS, verifiedIdentity: 'user_9000' },
      SECRET_A,
    );
    expect(
      (await verifyVisitorToken(withIdentity, SECRET_A)).verifiedIdentity,
    ).toBe('user_9000');

    const without = await signVisitorToken(CLAIMS, SECRET_A);
    expect(await verifyVisitorToken(without, SECRET_A)).not.toHaveProperty(
      'verifiedIdentity',
    );
  });

  it('REFUSES a token minted under another account’s secret', async () => {
    // The whole reason the key is per-account: cross-tenant replay fails
    // at the signature, not at a claim comparison someone has to
    // remember to write.
    const token = await signVisitorToken(CLAIMS, SECRET_A);
    await expect(verifyVisitorToken(token, SECRET_B)).rejects.toThrow(
      VisitorTokenError,
    );
  });

  it('treats rotating the secret as invalidating live sessions', async () => {
    const token = await signVisitorToken(CLAIMS, SECRET_A);
    const rotated = `${SECRET_A}-rotated`;
    await expect(verifyVisitorToken(token, rotated)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('rejects a tampered payload', async () => {
    const token = await signVisitorToken(CLAIMS, SECRET_A);
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    // Point the session at a different conversation — the attack the
    // signature exists to stop.
    decoded.cid = '99999999-9999-9999-9999-999999999999';
    const forged = [
      header,
      Buffer.from(JSON.stringify(decoded)).toString('base64url'),
      signature,
    ].join('.');

    await expect(verifyVisitorToken(forged, SECRET_A)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
      Buffer.from(JSON.stringify({ aid: CLAIMS.accountId })).toString(
        'base64url',
      ),
      '',
    ].join('.');
    await expect(verifyVisitorToken(unsigned, SECRET_A)).rejects.toThrow(
      VisitorTokenError,
    );
  });

  it('reports an expired token distinctly from an invalid one', async () => {
    // The split matters to the client: expired means "open a new session
    // and carry on", invalid means "stop retrying".
    const expired = await new SignJWT({
      aid: CLAIMS.accountId,
      vid: CLAIMS.visitorId,
      cid: CLAIMS.conversationId,
      ctc: CLAIMS.contactId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(SECRET_A));

    await expect(verifyVisitorToken(expired, SECRET_A)).rejects.toMatchObject({
      reason: 'expired',
    });
  });

  it('refuses a correctly signed token that is missing claims', async () => {
    // Our own minting code changing incompatibly, not an attack — but
    // downstream code would read `undefined` as a tenant id.
    const partial = await new SignJWT({ aid: CLAIMS.accountId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET_A));

    await expect(verifyVisitorToken(partial, SECRET_A)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('rejects junk without throwing something other than VisitorTokenError', async () => {
    for (const junk of ['', 'not-a-token', 'a.b.c', '...']) {
      await expect(verifyVisitorToken(junk, SECRET_A)).rejects.toThrow(
        VisitorTokenError,
      );
    }
  });
});

describe('generateVisitorId', () => {
  it('returns unique uuids', () => {
    const ids = new Set(Array.from({ length: 200 }, generateVisitorId));
    expect(ids.size).toBe(200);
    expect(generateVisitorId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
