import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from './marketing-objects.util';

/**
 * Meta requires an explicit answer to the ad-set budget-sharing question
 * whenever a campaign carries no budget of its own — which is every
 * campaign this product creates, since all five builders budget per ad
 * set. Omitting it is a 400 on the FIRST publish call, so nothing ships
 * at all; the message ("Must specify True or False in
 * is_adset_budget_sharing_enabled field") names a field no wizard step
 * mentions, which is what made it hard to place.
 */

function captureBody(): { body(): URLSearchParams } {
  let captured: URLSearchParams | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init?.body as URLSearchParams;
      return new Response(JSON.stringify({ id: '120200000000000' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return {
    body: () => {
      if (!captured) throw new Error('fetch was never called');
      return captured;
    },
  };
}

const BASE = {
  accessToken: 'tok',
  adAccountId: '123',
  name: 'Campaign',
  objective: 'OUTCOME_TRAFFIC',
  specialAdCategories: [],
  status: 'PAUSED' as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createCampaign — is_adset_budget_sharing_enabled', () => {
  it('sends an explicit false when the campaign has no budget', async () => {
    const captured = captureBody();
    await createCampaign(BASE);
    // Explicitly false, not absent: absent is the 400.
    expect(captured.body().get('is_adset_budget_sharing_enabled')).toBe(
      'false',
    );
  });

  it('honours an explicit true', async () => {
    const captured = captureBody();
    await createCampaign({ ...BASE, adSetBudgetSharing: true });
    expect(captured.body().get('is_adset_budget_sharing_enabled')).toBe('true');
  });

  it('omits the field when a campaign budget is set', async () => {
    // Not applicable under CBO — Meta rejects it there.
    const captured = captureBody();
    await createCampaign({ ...BASE, dailyBudgetMinor: 50_000 });
    expect(captured.body().has('is_adset_budget_sharing_enabled')).toBe(false);
    expect(captured.body().get('daily_budget')).toBe('50000');
  });
});
