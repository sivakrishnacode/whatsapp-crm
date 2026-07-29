/**
 * Where a contact first entered the account.
 *
 * `contacts.source` is a TEXT column guarded by `contacts_source_chk`
 * (migration 056) rather than a Postgres enum — same reasoning as
 * `conversations.channel`: adding a source is one ALTER of a CHECK
 * constraint. This module is the TypeScript half of that contract. Add
 * a value here and you must widen the constraint too, or the insert
 * fails at runtime.
 *
 * WRITE IT AT EVERY CREATION SITE
 *   The column's DB default is 'unknown', deliberately not 'manual'.
 *   Origin cannot be recovered after the fact — a phone-only contact
 *   looks identical whether it was typed in, imported, or created by an
 *   inbound message — so a creation path that omits this loses the
 *   information permanently. 'unknown' makes that visible in the UI
 *   instead of disguising it as a hand-entered contact.
 */

export const CONTACT_SOURCES = [
  'manual',
  'import',
  'whatsapp',
  'instagram',
  'web',
  'form',
  'facebook_lead',
  'api',
  'broadcast',
  'unknown',
] as const;

export type ContactSource = (typeof CONTACT_SOURCES)[number];

/**
 * What a contact is assumed to have come from when nothing says
 * otherwise — matches the column's DB default.
 */
export const DEFAULT_CONTACT_SOURCE: ContactSource = 'unknown';

export function isContactSource(value: unknown): value is ContactSource {
  return (
    typeof value === 'string' &&
    (CONTACT_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Coerce an untrusted value (API body, import payload) to a
 * ContactSource, falling back to 'unknown'.
 *
 * Callers should generally pass a literal instead: the source is a fact
 * the *code path* knows, not something a client should be able to
 * claim. This exists for the few places that legitimately forward a
 * caller-supplied origin.
 */
export function toContactSource(value: unknown): ContactSource {
  return isContactSource(value) ? value : DEFAULT_CONTACT_SOURCE;
}
