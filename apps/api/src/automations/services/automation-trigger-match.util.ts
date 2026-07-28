import type {
  AutomationContext,
  KeywordMatchTriggerConfig,
  KEYWORD_FILTERED_TRIGGERS,
} from '../automation.types';

// The trigger types that apply keyword filtering. Defined in automation.types.ts;
// imported here so the two definitions can't drift.
type KeywordFilteredTrigger = (typeof KEYWORD_FILTERED_TRIGGERS)[number];

const KEYWORD_FILTERED = new Set<string>([
  'keyword_match',
  'instagram_comment',
  'instagram_story_reply',
] satisfies KeywordFilteredTrigger[]);

/**
 * Ported from apps/web/src/lib/automations/engine.ts's `triggerMatches()`.
 *
 * `keyword_match`, `instagram_comment`, and `instagram_story_reply` all share
 * the same KeywordMatchTriggerConfig shape — if an author sets a keyword
 * filter, it must be honoured. Every other trigger type passes
 * unconditionally (the caller's accountId+triggerType+isActive query is the
 * real gate for those).
 */
export function triggerMatches(
  triggerType: string,
  triggerConfig: unknown,
  ctx: AutomationContext | undefined,
): boolean {
  if (!KEYWORD_FILTERED.has(triggerType)) return true;
  const cfg = triggerConfig as KeywordMatchTriggerConfig;
  const hasKeywords = Array.isArray(cfg?.keywords) && cfg.keywords.length > 0;
  if (!hasKeywords) {
    // For pure 'keyword_match', no keywords means it cannot match anything.
    // For Instagram comments/stories, keywords are optional filters (empty = match all).
    return triggerType !== 'keyword_match';
  }
  const text = (ctx?.message_text ?? '').toString();
  if (!text) return false;
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  return cfg.keywords.some((raw) => {
    const k = cfg.case_sensitive ? raw : raw.toLowerCase();
    return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k);
  });
}
