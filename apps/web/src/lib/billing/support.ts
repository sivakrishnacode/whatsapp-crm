/**
 * How a locked-out workspace reaches a human.
 *
 * Extending a trial is deliberately NOT self-serve: `trial_granted_at`
 * (migration 074) is a one-time latch, and only an operator in
 * apps/admin-panel can grant time after it, which is recorded in
 * `admin_audit_log`. So the product's job here is to hand the customer a
 * message that already contains everything that operator needs to find
 * them — not to promise an extension it cannot grant.
 */

/** Falls back to the address published in the site's privacy and terms. */
export const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@converse360.in";

/**
 * Digits only, no `+` — that is the form wa.me wants.
 *
 * Unset means the WhatsApp button does not render at all, which is the
 * right default: a wa.me link built from a placeholder number opens a
 * chat with nobody, and the customer reads that as "they ignored me".
 */
export const SUPPORT_WHATSAPP =
  process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP?.replace(/\D/g, "") || null;

export interface SupportContext {
  workspaceName: string;
  planDisplayName: string | null;
  /** Whatever the customer can quote to identify themselves. */
  email: string | null;
}

function requestBody({
  workspaceName,
  planDisplayName,
  email,
}: SupportContext): string {
  return [
    "Hello,",
    "",
    "Our free trial has ended and we would like a little more time before paying.",
    "",
    `Workspace: ${workspaceName}`,
    planDisplayName ? `Plan: ${planDisplayName}` : null,
    email ? `Account email: ${email}` : null,
    "",
    "Thank you.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** `mailto:` with the subject and body already filled in. */
export function trialExtensionMailto(context: SupportContext): string {
  const subject = `More trial time for ${context.workspaceName}`;
  return (
    `mailto:${SUPPORT_EMAIL}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(requestBody(context))}`
  );
}

/** wa.me link, or null when no number is configured. */
export function trialExtensionWhatsApp(
  context: SupportContext,
): string | null {
  if (!SUPPORT_WHATSAPP) return null;
  return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(
    requestBody(context),
  )}`;
}
