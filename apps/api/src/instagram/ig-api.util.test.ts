import { describe, it, expect, vi, afterEach } from 'vitest';
import { exchangeCodeForToken, getSelfProfile } from './ig-api.util';

/**
 * A real Instagram account id, and the reason this file exists.
 *
 *   28011694518467843  >  9007199254740992  (2^53)
 *
 * so `JSON.parse('{"user_id":28011694518467843}')` yields …844, not
 * …843. Every subsequent Graph call then addresses a nonexistent
 * object and Meta answers with a generic permissions error that never
 * hints at the real cause.
 */
const APP_SCOPED_ID = '28011694518467843';
const PROFESSIONAL_ID = '17841445515874274';

function mockJsonResponse(body: string) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exchangeCodeForToken — large-id precision', () => {
  it('preserves an account id wider than 2^53', async () => {
    // Note the id is an unquoted JSON *number*, exactly as Meta sends it.
    const raw = `{"access_token":"IGAA...","user_id":${APP_SCOPED_ID},"permissions":"instagram_business_basic"}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(raw)));

    const result = await exchangeCodeForToken({
      code: 'code',
      appId: 'app',
      appSecret: 'secret',
      redirectUri: 'https://example.test/cb',
    });

    expect(result.appScopedUserId).toBe(APP_SCOPED_ID);
    // The specific corruption this guards against.
    expect(result.appScopedUserId).not.toBe('28011694518467844');
  });

  it('demonstrates why JSON.parse cannot be used for this field', () => {
    // Not testing our code — pinning the platform behaviour that makes
    // the text-first parse necessary, so nobody "simplifies" it back.
    const parsed = JSON.parse(`{"user_id":${APP_SCOPED_ID}}`) as {
      user_id: number;
    };
    expect(String(parsed.user_id)).toBe('28011694518467844');
    expect(String(parsed.user_id)).not.toBe(APP_SCOPED_ID);
  });

  it('parses permissions from a comma-separated string', async () => {
    const raw = `{"access_token":"t","user_id":${APP_SCOPED_ID},"permissions":"a,b,c"}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(raw)));

    const result = await exchangeCodeForToken({
      code: 'c',
      appId: 'a',
      appSecret: 's',
      redirectUri: 'https://example.test/cb',
    });
    expect(result.permissions).toEqual(['a', 'b', 'c']);
  });

  it('fails loudly when no user_id comes back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse('{"access_token":"t"}')),
    );

    await expect(
      exchangeCodeForToken({
        code: 'c',
        appId: 'a',
        appSecret: 's',
        redirectUri: 'https://example.test/cb',
      }),
    ).rejects.toThrow(/user_id/);
  });
});

describe('getSelfProfile — the two ids', () => {
  it('returns the professional id, not the app-scoped one', async () => {
    // Shape confirmed against a live account: `user_id` is the
    // professional account id that the Graph API accepts as an object
    // id; `id` is the app-scoped one. Subscribing webhooks with `id`
    // fails with a misleading "does not exist" error.
    const raw = `{"user_id":${PROFESSIONAL_ID},"username":"___siva19","name":"Siva Krishna","id":"${APP_SCOPED_ID}"}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(raw)));

    const profile = await getSelfProfile({
      igUserId: 'me',
      accessToken: 't',
    });

    expect(profile.igUserId).toBe(PROFESSIONAL_ID);
    expect(profile.igAppScopedId).toBe(APP_SCOPED_ID);
    expect(profile.username).toBe('___siva19');
  });

  it('preserves both ids exactly when both are wide numbers', async () => {
    const raw = `{"user_id":${PROFESSIONAL_ID},"id":${APP_SCOPED_ID}}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(raw)));

    const profile = await getSelfProfile({ igUserId: 'me', accessToken: 't' });

    expect(profile.igUserId).toBe(PROFESSIONAL_ID);
    expect(profile.igAppScopedId).toBe(APP_SCOPED_ID);
  });

  it('omits the app-scoped id when it equals the professional id', async () => {
    // Storing the same value twice would make the partial unique index
    // on ig_app_scoped_id reject an unrelated second account.
    const raw = `{"user_id":${PROFESSIONAL_ID},"id":${PROFESSIONAL_ID}}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(raw)));

    const profile = await getSelfProfile({ igUserId: 'me', accessToken: 't' });

    expect(profile.igUserId).toBe(PROFESSIONAL_ID);
    expect(profile.igAppScopedId).toBeUndefined();
  });
});
