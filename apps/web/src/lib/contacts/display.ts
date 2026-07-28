import type { Contact } from '@/types';

/**
 * How to render a contact who may have no phone number.
 *
 * `contacts.phone` became nullable when Instagram landed (migration
 * 050): an Instagram-only contact is identified by an Instagram-scoped
 * ID and has no phone at all. Before that, `contact.name || contact.phone`
 * was a safe idiom across the UI; now it yields `null` and renders as a
 * blank name or throws on `.charAt(0)`.
 *
 * Centralised so the fallback order is decided once. Every caller wants
 * the same answer to "what do I put on screen for this person", and
 * six slightly different local guards is how avatars end up showing "U"
 * on one screen and "?" on another.
 */

/**
 * Subset these helpers need — accepts a full Contact or a partial join.
 *
 * Every field is independently nullable rather than reusing Contact's
 * exact optionality: rows arrive here from Supabase joins and select
 * projections where an absent column is `null`, not `undefined`.
 */
type ContactLike = {
  name?: string | null;
  phone?: string | null;
} & Partial<Pick<Contact, 'ig_username' | 'ig_scoped_id'>>;

/**
 * Best human-readable label, in descending order of usefulness:
 * their name, then their @handle, then their phone, then a placeholder.
 *
 * Never returns an empty string, so `.charAt(0)` is always safe.
 */
export function contactDisplayName(
  contact: ContactLike | null | undefined,
): string {
  if (!contact) return 'Unknown';
  const name = contact.name?.trim();
  if (name) return name;
  if (contact.ig_username) return `@${contact.ig_username}`;
  const phone = contact.phone?.trim();
  if (phone) return phone;
  return 'Unknown';
}

/**
 * The secondary identifier shown under the name — a phone number on
 * WhatsApp, an @handle on Instagram.
 *
 * Returns null when there is nothing worth showing, including when the
 * handle is already serving as the display name (rendering "@siva19"
 * twice, stacked, looks like a bug).
 */
export function contactHandle(
  contact: ContactLike | null | undefined,
): string | null {
  if (!contact) return null;
  const phone = contact.phone?.trim();
  if (phone) return phone;
  if (contact.ig_username && contact.name?.trim()) {
    return `@${contact.ig_username}`;
  }
  return null;
}

/**
 * Single uppercase character for an avatar fallback.
 *
 * Total: `contactDisplayName` is guaranteed non-empty, so there is no
 * empty-string case to guard against here.
 */
export function contactInitial(
  contact: ContactLike | null | undefined,
): string {
  // Strip a leading '@' so Instagram contacts get their first real
  // letter instead of every avatar showing "@".
  const label = contactDisplayName(contact).replace(/^@/, '');
  return label.charAt(0).toUpperCase();
}

/** True when this contact can only be reached on Instagram. */
export function isInstagramOnly(
  contact: ContactLike | null | undefined,
): boolean {
  return Boolean(contact?.ig_scoped_id && !contact?.phone);
}
