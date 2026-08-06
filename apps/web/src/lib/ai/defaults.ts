import type { AiProvider } from './types'

// ============================================================
// Model choices offered in the provider form.
//
// Model ids churn fast and this is a bring-your-own-key product, so the
// lists below are a starting point, never an allow-list: the API accepts
// any id the provider does, and a model already saved is kept in the
// dropdown even when it is not listed here.
// ============================================================

export const AI_PROVIDER_DEFAULT_MODEL: Record<AiProvider, string> = {
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-3.5-flash',
}

export const PROVIDER_MODELS: Record<
  AiProvider,
  Array<{ value: string; label: string }>
> = {
  openai: [
    { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini (fast, cheapest)' },
    { value: 'gpt-5.4', label: 'gpt-5.4 (most capable)' },
    { value: 'gpt-4o-mini', label: 'gpt-4o-mini (legacy, low cost)' },
    { value: 'gpt-4o', label: 'gpt-4o (legacy flagship)' },
  ],
  anthropic: [
    {
      value: 'claude-haiku-4-5-20251001',
      label: 'claude-haiku-4.5 (fast, cheapest)',
    },
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5 (balanced)' },
    { value: 'claude-opus-5', label: 'claude-opus-5 (most capable)' },
  ],
  gemini: [
    { value: 'gemini-3.5-flash', label: 'gemini-3.5-flash (fast, cheapest)' },
    { value: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (cheapest)' },
    { value: 'gemini-3-pro-preview', label: 'gemini-3-pro (most capable)' },
    { value: 'gemini-flash-latest', label: 'gemini-flash-latest (rolling)' },
  ],
}

/**
 * Sentinel the model emits (in auto-reply mode) when it cannot
 * confidently help and a human should take over. Parsed and stripped
 * server-side; the inbox shows it as a handoff badge.
 */
export const HANDOFF_SENTINEL = '[[HANDOFF]]'
