import type { AutomationContext } from '../automation.types';

/**
 * Ported from apps/web/src/lib/automations/engine.ts's `interpolate()`.
 * Resolves only `{{message.text}}` and `{{vars.<key>}}` — anything else
 * (unknown namespace, malformed key) resolves to an empty string.
 */
export function interpolate(
  s: string,
  context: AutomationContext | undefined,
): string {
  const ctx = context ?? {};
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.');
    if (ns === 'message' && prop === 'text')
      return String(ctx.message_text ?? '');
    if (ns === 'vars' && prop)
      return String((ctx.vars?.[prop] ?? '') as string | number | boolean);
    return '';
  });
}
