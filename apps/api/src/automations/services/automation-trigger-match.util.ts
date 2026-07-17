import type {
  AutomationContext,
  KeywordMatchTriggerConfig,
} from '../automation.types';

/**
 * Ported from apps/web/src/lib/automations/engine.ts's `triggerMatches()`.
 * Only `keyword_match` filters further — every other trigger type passes
 * unconditionally (the caller's accountId+triggerType+isActive query is
 * the real gate for those).
 */
export function triggerMatches(
  triggerType: string,
  triggerConfig: unknown,
  ctx: AutomationContext | undefined,
): boolean {
  if (triggerType !== 'keyword_match') return true;
  const cfg = triggerConfig as KeywordMatchTriggerConfig;
  if (!cfg?.keywords || cfg.keywords.length === 0) return false;
  const text = (ctx?.message_text ?? '').toString();
  if (!text) return false;
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  return cfg.keywords.some((raw) => {
    const k = cfg.case_sensitive ? raw : raw.toLowerCase();
    return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k);
  });
}
