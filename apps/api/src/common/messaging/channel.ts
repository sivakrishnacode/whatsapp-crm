/**
 * The set of platforms a conversation can live on.
 *
 * `conversations.channel` is a TEXT column guarded by
 * `conversations_channel_chk` (migration 050) rather than a Postgres
 * enum — adding a channel is then one ALTER of a CHECK constraint, not
 * an enum migration. This module is the TypeScript half of that
 * contract: the DB rejects unknown values, and `isChannel` is what
 * stops one reaching the DB in the first place.
 *
 * WHY THE FILTER MATTERS EVERYWHERE
 *   Before Instagram, "the conversation for this contact" was
 *   unambiguous and several call sites look one up with
 *   `findFirst({ where: { account_id, contact_id } })`. A contact can
 *   now legitimately own one thread per channel, so an unfiltered
 *   lookup can return the wrong one and route a reply to the wrong
 *   platform. Every such lookup must pin the channel.
 */

export const CHANNELS = ['whatsapp', 'instagram'] as const;

export type Channel = (typeof CHANNELS)[number];

/**
 * What a conversation is assumed to be when nothing says otherwise —
 * matches the column's DB default, so every pre-Instagram row is
 * WhatsApp.
 */
export const DEFAULT_CHANNEL: Channel = 'whatsapp';

export function isChannel(value: unknown): value is Channel {
  return (
    typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)
  );
}

/**
 * Coerce an untrusted value (query string, webhook payload, API body)
 * to a Channel, falling back to WhatsApp.
 */
export function toChannel(value: unknown): Channel {
  return isChannel(value) ? value : DEFAULT_CHANNEL;
}

/**
 * Capabilities that differ per channel. Kept as data rather than
 * scattered `if (channel === 'instagram')` checks so that adding a
 * channel is one row here, and so the engines (flows, automations) can
 * ask "can I do this?" without knowing platform specifics.
 */
export interface ChannelCapabilities {
  /** Pre-approved templates for out-of-window re-engagement. */
  templates: boolean;
  /** Bulk sends to an audience. Requires templates to be compliant. */
  broadcasts: boolean;
  /** Per-message delivery receipts (as opposed to read receipts only). */
  deliveryReceipts: boolean;
  /** Interactive reply buttons. */
  buttons: boolean;
  /** Interactive single-select list messages. */
  lists: boolean;
  /** Product / catalog messages. */
  catalog: boolean;
  /**
   * How long after the customer's last message the business may reply
   * freely, in hours.
   */
  replyWindowHours: number;
}

export const CHANNEL_CAPABILITIES: Record<Channel, ChannelCapabilities> = {
  whatsapp: {
    templates: true,
    broadcasts: true,
    deliveryReceipts: true,
    buttons: true,
    lists: true,
    catalog: true,
    replyWindowHours: 24,
  },
  instagram: {
    // Instagram has no template mechanism at all. That single fact is
    // why broadcasts are impossible here — there is no compliant way to
    // send bulk unsolicited DMs, and attempting it gets apps restricted.
    templates: false,
    broadcasts: false,
    // Instagram emits `messaging_seen` (read) but never a delivery
    // receipt. The inbox must not render a "delivered" tick that can
    // never arrive.
    deliveryReceipts: false,
    // Button templates and quick replies — different wire format from
    // WhatsApp's interactive buttons, same user-facing affordance.
    buttons: true,
    lists: false,
    catalog: false,
    replyWindowHours: 24,
  },
};

export function capabilitiesFor(channel: Channel): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[channel];
}
