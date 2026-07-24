/**
 * Template usability — is a template actually sendable from a production
 * WhatsApp number?
 *
 * Meta ships a sample template named `hello_world` with every WABA. It can
 * ONLY be sent from Meta's public test numbers; sending it from a real
 * business number fails with Meta error (#131058, "Hello World templates can
 * only be sent from the Public Test Numbers"). It is therefore never usable in
 * production, so we treat it as unusable and hide it from every send-selection
 * surface (inbox, broadcasts/campaigns, automations). It stays visible in
 * Settings → Templates so it can still be inspected and deleted.
 */

/** Approved-but-unsendable Meta sample templates, keyed by lowercased name. */
export const UNSENDABLE_SAMPLE_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  'hello_world',
]);

/**
 * Whether a template can be sent from a production WhatsApp number. Returns
 * `false` for Meta's test-number-only sample templates (e.g. `hello_world`).
 */
export function isTemplateUsable(
  template: { name?: string | null } | null | undefined,
): boolean {
  const name = template?.name?.trim().toLowerCase();
  if (!name) return true;
  return !UNSENDABLE_SAMPLE_TEMPLATE_NAMES.has(name);
}
