import { AiError } from '../lib/types';

/**
 * ============================================================
 * What a credit is, and what the platform key is.
 *
 * The whole point of this file is that the *price* of a credit lives in
 * the database (`ai_credit_packs`) while the *cost* of a credit lives
 * here in code. Keeping them apart means a price can be corrected from
 * the admin panel without a deploy, and the metering can be tuned when
 * a model's rates change without anyone editing a price by hand and
 * accidentally rewriting what a past purchase was worth.
 * ============================================================
 */

/**
 * One credit buys this many WEIGHTED tokens.
 *
 * Weighted, because input and output are not the same purchase: on
 * every provider worth using, generated tokens cost several times what
 * prompt tokens cost. Charging a flat per-token rate would make a long
 * knowledge-grounded prompt look as expensive as a long answer, which
 * is backwards — the prompt is the cheap half.
 *
 * 4,000 weighted tokens is sized so that a typical grounded reply
 * (~2,000 prompt, ~300 generated → 3,200 weighted) costs one credit,
 * and a three-round tool loop costs three or four. That is the honest
 * shape: the expensive conversations are the ones that charge more.
 */
export const WEIGHTED_TOKENS_PER_CREDIT = 4000;

/** Generated tokens are billed at roughly this multiple of prompt tokens. */
export const OUTPUT_TOKEN_WEIGHT = 4;

/**
 * Embeddings are two orders of magnitude cheaper per token than
 * generation, so metering them at the reply rate would make indexing a
 * PDF cost more than a month of conversations. They are still metered —
 * a knowledge base is not free to build — just at a rate that reflects
 * what it actually costs.
 */
export const EMBEDDING_TOKENS_PER_CREDIT = 25_000;

/** Below this, the UI warns and the badge turns amber. */
export const LOW_BALANCE_THRESHOLD = 50;

/** Granted once per workspace, on first touch. Overridable for pilots. */
export function signupGrantCredits(): number {
  const raw = Number(process.env.AI_SIGNUP_GRANT_CREDITS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 250;
}

/**
 * Charge for one generation, from the tokens it really used.
 *
 * The floor of one credit is not a rounding artefact: a reply that
 * reports zero tokens still cost us a request, and a provider that
 * omits `usage` must not become a way to run the agent for free.
 */
export function creditsForGeneration(usage: {
  inputTokens: number;
  outputTokens: number;
}): number {
  const weighted =
    Math.max(0, usage.inputTokens) +
    Math.max(0, usage.outputTokens) * OUTPUT_TOKEN_WEIGHT;
  return Math.max(1, Math.ceil(weighted / WEIGHTED_TOKENS_PER_CREDIT));
}

/** Charge for indexing. One credit minimum — it is an explicit action. */
export function creditsForEmbedding(tokens: number): number {
  return Math.max(
    1,
    Math.ceil(Math.max(0, tokens) / EMBEDDING_TOKENS_PER_CREDIT),
  );
}

/**
 * Embedding APIs do not all report token counts, and the ones that do
 * report them inconsistently across batches. Four characters per token
 * is the usual English approximation and it only has to be good enough
 * to bill at 1/25,000th of a credit each.
 */
export function estimateEmbeddingTokens(texts: string[]): number {
  return Math.ceil(texts.reduce((sum, t) => sum + t.length, 0) / 4);
}

/**
 * ============================================================
 * The platform key.
 *
 * ⚠️ This key is OURS. Three rules follow from that and none of them
 * are negotiable:
 *
 *   1. It never leaves the server. Not in an API response, not in a
 *      queue job payload (Redis stores those in plaintext and Bull
 *      Board renders them), not in a log line.
 *   2. Every call made with it is metered, including the playground.
 *      An unmetered test surface is an open inference proxy with a
 *      login page in front of it.
 *   3. It is read from the environment at call time, never cached in a
 *      module-level constant, so rotating it takes effect on the next
 *      call rather than the next deploy.
 * ============================================================
 */
export function platformApiKey(): string | null {
  const key = process.env.AI_PLATFORM_GEMINI_KEY?.trim();
  return key ? key : null;
}

/**
 * The model our credits buy.
 *
 * Deliberately the cheapest tier with the highest rate limits rather
 * than the best one: this key is shared by every workspace on platform
 * mode, so a model with a low requests-per-minute ceiling makes one
 * busy tenant into an outage for all of them. Quality is recovered
 * through the prompt and retrieved knowledge, which is where it
 * actually comes from for support replies. A workspace that wants a
 * frontier model can switch to their own key and pay for it.
 */
export function platformModel(): string {
  return process.env.AI_PLATFORM_MODEL?.trim() || 'gemini-3.5-flash-lite';
}

/** Same key, so platform accounts get semantic search without their own. */
export function platformEmbeddingsModel(): string {
  return (
    process.env.AI_PLATFORM_EMBEDDINGS_MODEL?.trim() || 'gemini-embedding-001'
  );
}

export function isPlatformAiAvailable(): boolean {
  return platformApiKey() !== null;
}

/**
 * The one credit check, called by all three entry points before they
 * spend anything.
 *
 * `loadAiConfig` has already run the fallback chain by this point, so a
 * config that still says `platform` with nothing in the wallet means
 * there is genuinely no way to serve this call — they have no key of
 * their own to fall back to. That is the only case that stops here.
 *
 * A `byok` run never reaches the throw: their provider bills them, and
 * inventing a quota on top of that is the theatre migration 069 was
 * right to refuse.
 */
export function assertCanSpendCredits(config: {
  source: 'platform' | 'byok';
  creditBalance: number;
}): void {
  if (config.source !== 'platform') return;
  if (config.creditBalance >= 1) return;
  // AiError rather than a new class: every entry point already maps it
  // to an HTTP status and shows its message, so a second error type
  // would only add a second place to forget to handle.
  throw new AiError(
    'You have run out of AI credits. Top up from AI Agents → Provider, or switch the agent to your own provider key.',
    { code: 'ai_credits_exhausted', status: 402 },
  );
}
