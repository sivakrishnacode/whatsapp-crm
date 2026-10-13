import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPhoneNumberLimits } from './meta-api.util';

// A minimal Response stand-in for the global fetch mock.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = vi.fn();

/** Typed view of the Nth fetch(url, init) call. */
function fetchCall(n: number): [string, RequestInit] {
  return fetchMock.mock.calls[n] as [string, RequestInit];
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPhoneNumberLimits', () => {
  it('asks for the portfolio limit as well as the deprecated per-number tier', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await fetchPhoneNumberLimits({ phoneNumberId: 'pn-1', accessToken: 'tok' });

    const [url, init] = fetchCall(0);
    expect(url).toContain('/pn-1?fields=');
    expect(url).toContain('whatsapp_business_manager_messaging_limit');
    expect(url).toContain('messaging_limit_tier');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('reads the portfolio limit when Meta no longer sends the per-number tier', async () => {
    // The shape a live 2K portfolio returned: no messaging_limit_tier at all.
    fetchMock.mockResolvedValue(
      jsonResponse({
        whatsapp_business_manager_messaging_limit: 'TIER_2K',
        quality_rating: 'GREEN',
        verified_name: 'dffrnt',
      }),
    );

    const limits = await fetchPhoneNumberLimits({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
    });

    expect(limits.messagingLimitTier).toBe('TIER_2K');
    expect(limits.qualityRating).toBe('GREEN');
  });

  it('prefers the portfolio limit when both fields are present', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        whatsapp_business_manager_messaging_limit: 'TIER_10K',
        messaging_limit_tier: 'TIER_1K',
      }),
    );

    const limits = await fetchPhoneNumberLimits({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
    });

    expect(limits.messagingLimitTier).toBe('TIER_10K');
  });

  it('falls back to the per-number tier when only that is returned', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ messaging_limit_tier: 'TIER_250' }),
    );

    const limits = await fetchPhoneNumberLimits({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
    });

    expect(limits.messagingLimitTier).toBe('TIER_250');
  });

  it('reports no tier when Meta returns neither field', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ quality_rating: 'GREEN' }));

    const limits = await fetchPhoneNumberLimits({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
    });

    expect(limits.messagingLimitTier).toBeNull();
  });
});
