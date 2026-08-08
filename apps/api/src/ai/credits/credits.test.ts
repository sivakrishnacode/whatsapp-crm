import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateReply } from '../lib/generate';
import {
  WEIGHTED_TOKENS_PER_CREDIT,
  assertCanSpendCredits,
  creditsForEmbedding,
  creditsForGeneration,
  platformModel,
} from './credits.constants';
import { AiError, type ToolDefinition } from '../lib/types';

/**
 * ============================================================
 * What a credit costs, and that a tool loop pays for every round.
 *
 * The second one is the whole reason `GenerateResult.usage` exists. A
 * three-round reply is three billable provider calls, each re-sending
 * the entire transcript, and charging only the last one would let the
 * most expensive conversations be the cheapest ones — the exact
 * inversion the token metering was chosen to avoid.
 * ============================================================
 */

function geminiText(
  text: string,
  usage?: { prompt: number; candidates: number; thoughts?: number },
): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      ...(usage
        ? {
            usageMetadata: {
              promptTokenCount: usage.prompt,
              candidatesTokenCount: usage.candidates,
              ...(usage.thoughts ? { thoughtsTokenCount: usage.thoughts } : {}),
            },
          }
        : {}),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function geminiCall(
  name: string,
  usage: { prompt: number; candidates: number },
): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ functionCall: { name, args: {} } }] } },
      ],
      usageMetadata: {
        promptTokenCount: usage.prompt,
        candidatesTokenCount: usage.candidates,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const config = {
  provider: 'gemini' as const,
  model: 'gemini-3.5-flash-lite',
  apiKey: 'k',
};

const tools: ToolDefinition[] = [
  {
    name: 'lookup_orders',
    description: 'Look up orders',
    parameters: { type: 'object', properties: {} },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_PLATFORM_MODEL;
});

describe('creditsForGeneration', () => {
  it('charges at least one credit even when the provider reports nothing', () => {
    // A provider that omits `usage` must not become a free-inference
    // bug — the request cost us money whether or not it was counted.
    expect(creditsForGeneration({ inputTokens: 0, outputTokens: 0 })).toBe(1);
  });

  it('weights generated tokens above prompt tokens', () => {
    const promptHeavy = creditsForGeneration({
      inputTokens: 4000,
      outputTokens: 0,
    });
    const outputHeavy = creditsForGeneration({
      inputTokens: 0,
      outputTokens: 4000,
    });
    // Same token count, four times the charge — because generated
    // tokens cost roughly four times as much to buy.
    expect(outputHeavy).toBe(promptHeavy * 4);
  });

  it('prices a typical grounded reply at one credit', () => {
    // ~2,000 prompt + ~300 generated = 3,200 weighted, under the 4,000
    // that buys a credit. This is the case the pack pricing was sized
    // against; if it drifts above 1, every published price is wrong.
    expect(creditsForGeneration({ inputTokens: 2000, outputTokens: 300 })).toBe(
      1,
    );
  });

  it('rounds up, so a fractional overage is never free', () => {
    expect(
      creditsForGeneration({
        inputTokens: WEIGHTED_TOKENS_PER_CREDIT + 1,
        outputTokens: 0,
      }),
    ).toBe(2);
  });
});

describe('creditsForEmbedding', () => {
  it('meters indexing far cheaper than generation', () => {
    // 25,000 tokens of knowledge for one credit; the same tokens
    // through a chat model would be six.
    expect(creditsForEmbedding(25_000)).toBe(1);
    expect(creditsForEmbedding(25_001)).toBe(2);
  });

  it('still charges for a tiny document', () => {
    expect(creditsForEmbedding(10)).toBe(1);
  });
});

describe('assertCanSpendCredits', () => {
  it('never blocks a bring-your-own-key run, even at zero balance', () => {
    // Their provider bills them directly. A quota on top of that is the
    // theatre migration 069 refused to build.
    expect(() =>
      assertCanSpendCredits({ source: 'byok', creditBalance: 0 }),
    ).not.toThrow();
  });

  it('blocks a platform run with an empty wallet', () => {
    try {
      assertCanSpendCredits({ source: 'platform', creditBalance: 0 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).code).toBe('ai_credits_exhausted');
      // 402 so the web app can tell "top up" apart from every other
      // failure and open the recharge sheet instead of a red toast.
      expect((err as AiError).status).toBe(402);
    }
  });

  it('allows a platform run with a single credit left', () => {
    expect(() =>
      assertCanSpendCredits({ source: 'platform', creditBalance: 1 }),
    ).not.toThrow();
  });
});

describe('platformModel', () => {
  it('defaults to a cheap, high-rate-limit model', () => {
    // One key serves every platform workspace, so a model with a low
    // requests-per-minute ceiling turns one busy tenant into an outage
    // for all of them.
    expect(platformModel()).toBe('gemini-3.5-flash-lite');
  });

  it('is overridable without a deploy', () => {
    process.env.AI_PLATFORM_MODEL = 'gemini-2.5-flash';
    expect(platformModel()).toBe('gemini-2.5-flash');
  });
});

describe('generateReply usage accounting', () => {
  it('reports what one call spent', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          geminiText('Hello', { prompt: 1200, candidates: 90 }),
        ),
    );

    const result = await generateReply({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 90,
      rounds: 1,
    });
  });

  it('bills thinking tokens as output', async () => {
    // Google reports `thoughtsTokenCount` separately but charges it at
    // the output rate. On a thinking model it routinely exceeds the
    // visible reply, so dropping it would meter a fraction of the cost.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          geminiText('Yes.', { prompt: 800, candidates: 40, thoughts: 260 }),
        ),
    );

    const result = await generateReply({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.usage.outputTokens).toBe(300);
  });

  it('sums every round of a tool loop, not just the last', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        geminiCall('lookup_orders', { prompt: 1000, candidates: 20 }),
      )
      .mockResolvedValueOnce(
        geminiCall('lookup_orders', { prompt: 1400, candidates: 25 }),
      )
      .mockResolvedValueOnce(
        geminiText('Shipped.', { prompt: 1800, candidates: 60 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateReply({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'where is my order' }],
      tools,
      executeTool: vi.fn().mockResolvedValue({ ok: true, detail: 'shipped' }),
    });

    expect(result.usage.rounds).toBe(3);
    expect(result.usage.inputTokens).toBe(4200);
    expect(result.usage.outputTokens).toBe(105);

    // The charge reflects all three calls. Metering the final round
    // alone would have billed this at 1 credit.
    expect(creditsForGeneration(result.usage)).toBe(2);
  });

  it('counts a round whose usage the provider did not report', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiText('Hi')));

    const result = await generateReply({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      rounds: 1,
    });
    expect(creditsForGeneration(result.usage)).toBe(1);
  });
});
