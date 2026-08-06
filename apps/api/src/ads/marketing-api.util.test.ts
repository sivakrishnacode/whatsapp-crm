import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encodeGraphParams,
  getAdAccounts,
  graphRequest,
  readRateLimitUsage,
  stripActPrefix,
  toActPath,
} from './marketing-api.util';
import {
  MetaRateLimitError,
  MetaTokenExpiredError,
} from '../common/messaging/meta-errors';

/**
 * The properties worth pinning here are the ones whose failure costs
 * money or duplicates a live ad, not the happy-path plumbing:
 *
 *   * `act_` normalisation — a double prefix 400s with a generic error
 *   * param encoding — a nested object sent as `[object Object]` is how
 *     targeting silently becomes "everyone"
 *   * GET retries but writes never do — a retried POST creates a second
 *     campaign, and Meta gives us no idempotency key to lean on
 */

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ad account id normalisation', () => {
  it('adds the act_ prefix exactly once', () => {
    expect(toActPath('123')).toBe('act_123');
    // Idempotent: `act_act_123` is a 400 with a message that names
    // neither the field nor the value.
    expect(toActPath('act_123')).toBe('act_123');
  });

  it('strips the prefix for storage, idempotently', () => {
    expect(stripActPrefix('act_123')).toBe('123');
    expect(stripActPrefix('123')).toBe('123');
  });
});

describe('encodeGraphParams', () => {
  it('JSON-encodes nested objects rather than stringifying them', () => {
    const encoded = encodeGraphParams({
      targeting: { geo_locations: { countries: ['IN'] }, age_min: 18 },
    });
    expect(encoded.get('targeting')).toBe(
      '{"geo_locations":{"countries":["IN"]},"age_min":18}',
    );
    // The failure this guards against.
    expect(encoded.get('targeting')).not.toContain('[object Object]');
  });

  it('sends an empty array as a literal [] — special_ad_categories needs it', () => {
    // Meta rejects a campaign create with special_ad_categories absent,
    // so "no categories apply" has to be transmitted, not omitted.
    expect(
      encodeGraphParams({ special_ad_categories: [] }).get(
        'special_ad_categories',
      ),
    ).toBe('[]');
  });

  it('drops undefined but transmits null as empty', () => {
    const encoded = encodeGraphParams({ a: undefined, b: null, c: 0 });
    expect(encoded.has('a')).toBe(false);
    // Clearing stop_time is expressed as an empty value, not an absent key.
    expect(encoded.get('b')).toBe('');
    // 0 is a real budget/bid value and must survive.
    expect(encoded.get('c')).toBe('0');
  });

  it('keeps booleans as unquoted literals', () => {
    expect(encodeGraphParams({ async: true }).get('async')).toBe('true');
  });
});

describe('readRateLimitUsage', () => {
  it('reports the worst business use-case utilisation, not the first', () => {
    const usage = readRateLimitUsage(
      jsonResponse(
        {},
        {
          headers: {
            'x-ad-account-usage': JSON.stringify({
              acc_id_util_pct: 42,
              reset_time_duration: 300,
              ads_api_access_tier: 'development_access',
            }),
            'x-business-use-case-usage': JSON.stringify({
              '100': [
                { type: 'ads_management', call_count: 10, total_time: 5 },
                {
                  type: 'ads_insights',
                  call_count: 91,
                  estimated_time_to_regain_access: 120,
                },
              ],
            }),
          },
        },
      ),
    );

    expect(usage.adAccountUtilPct).toBe(42);
    expect(usage.accessTier).toBe('development_access');
    // 91 is the one that will cut us off first.
    expect(usage.businessUtilPct).toBe(91);
    expect(usage.estimatedTimeToRegainAccess).toBe(120);
  });

  it('survives a malformed header instead of failing the request', () => {
    const usage = readRateLimitUsage(
      jsonResponse({}, { headers: { 'x-ad-account-usage': '{"trunc' } }),
    );
    expect(usage.adAccountUtilPct).toBeNull();
  });
});

describe('graphRequest', () => {
  it('puts GET params in the query string and sends a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    vi.stubGlobal('fetch', fetchMock);

    await graphRequest({
      path: '/act_9/campaigns',
      accessToken: 'tok',
      params: { fields: 'id,name' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/act_9/campaigns?fields=id%2Cname');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
    expect(init.body).toBeUndefined();
  });

  it('form-encodes POST params into the body, not the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    vi.stubGlobal('fetch', fetchMock);

    await graphRequest({
      path: '/act_9/campaigns',
      accessToken: 'tok',
      method: 'POST',
      params: { name: 'Test', special_ad_categories: [] },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('?');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    // Narrowed rather than String()'d: `BodyInit` includes types whose
    // default stringification is "[object Object]", which would make this
    // assertion pass for the wrong reason.
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect((init.body as URLSearchParams).toString()).toBe(
      'name=Test&special_ad_categories=%5B%5D',
    );
  });

  it('retries a throttled GET', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: 'rate limited', code: 4 } },
          {
            status: 429,
          },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = graphRequest<{ id: string }>({
      path: '/act_9/campaigns',
      accessToken: 'tok',
    });
    await vi.runAllTimersAsync();
    const { data } = await promise;

    expect(data.id).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('NEVER retries a throttled write — a retried create buys two campaigns', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { message: 'rate limited', code: 4 } },
        {
          status: 429,
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      graphRequest({
        path: '/act_9/campaigns',
        accessToken: 'tok',
        method: 'POST',
        params: { name: 'Test' },
      }),
    ).rejects.toBeInstanceOf(MetaRateLimitError);

    // The whole point: one attempt, so a partial publish is a KNOWN
    // state the rollback can unwind rather than a maybe-duplicate.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies an expired token so jobs can skip the account', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { message: 'Session expired', code: 190 } },
            { status: 401 },
          ),
        ),
    );

    await expect(
      graphRequest({ path: '/me', accessToken: 'dead' }),
    ).rejects.toBeInstanceOf(MetaTokenExpiredError);
  });

  it('surfaces error_user_msg instead of the generic message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              message: 'Invalid parameter',
              error_user_title: 'Budget too low',
              error_user_msg: 'The daily budget must be at least ₹89.',
              code: 100,
            },
          },
          { status: 400 },
        ),
      ),
    );

    await expect(
      graphRequest({ path: '/act_9/adsets', accessToken: 'tok' }),
    ).rejects.toThrow(/Budget too low — The daily budget must be at least/);
  });
});

describe('getAdAccounts', () => {
  it('merges a business’s owned AND client accounts, deduped', async () => {
    // An agency's accounts live on the client edge; reading only the
    // owned edge is why an agency user sees an empty picker.
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        jsonResponse({
          data: url.includes('owned_ad_accounts')
            ? [
                {
                  account_id: '1',
                  name: 'Owned',
                  account_status: 1,
                  funding_source: 'fs',
                },
                { account_id: '2', name: 'Dupe', account_status: 1 },
              ]
            : [{ account_id: '2', name: 'Dupe', account_status: 1 }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const accounts = await getAdAccounts({
      accessToken: 'tok',
      businessId: '77',
    });

    expect(accounts.map((a) => a.id)).toEqual(['1', '2']);
    // funding_ok is our stand-in for "can this account actually spend".
    expect(accounts[0].fundingOk).toBe(true);
    expect(accounts[1].fundingOk).toBe(false);
  });

  it('treats a non-active account as unable to spend even with funding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            {
              account_id: '5',
              name: 'Disabled',
              account_status: 2,
              funding_source: 'fs',
            },
          ],
        }),
      ),
    );

    const [account] = await getAdAccounts({ accessToken: 'tok' });
    expect(account.fundingOk).toBe(false);
  });
});
