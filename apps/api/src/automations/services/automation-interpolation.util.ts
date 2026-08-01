import type { AutomationContext } from '../automation.types';

/**
 * Ported from apps/web/src/lib/automations/engine.ts's `interpolate()`.
 * Resolves `{{message.text}}`, `{{vars.<key>}}` and `{{contact.<field>}}`
 * — anything else (unknown namespace, malformed key) resolves to an
 * empty string.
 *
 * Resolving an unknown token to "" rather than leaving it verbatim is
 * deliberate and load-bearing: an unresolved `{{vars.name}}` sent to a
 * customer reads as a broken app, whereas a gap reads as a typo in the
 * copy. It also keeps a template variable from being rejected by Meta
 * for containing braces.
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
    if (ns === 'contact' && prop)
      return String((ctx.contact?.[prop] ?? '') as string | number | boolean);
    return '';
  });
}
