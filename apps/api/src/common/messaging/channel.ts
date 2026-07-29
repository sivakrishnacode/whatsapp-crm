/**
 * The set of platforms a conversation can live on.
 *
 * `conversations.channel` is a TEXT column guarded by
 * `conversations_channel_chk` (migration 050, widened for web in 053)
 * rather than a Postgres enum — adding a channel is then one ALTER of a
 * CHECK constraint, not an enum migration. This module is the
 * TypeScript half of that contract: the DB rejects unknown values, and
 * `isChannel` is what stops one reaching the DB in the first place.
 *
 * WHY THE FILTER MATTERS EVERYWHERE
 *   Before Instagram, "the conversation for this contact" was
 *   unambiguous and several call sites look one up with
 *   `findFirst({ where: { account_id, contact_id } })`. A contact can
 *   now legitimately own one thread per channel, so an unfiltered
 *   lookup can return the wrong one and route a reply to the wrong
 *   platform. Every such lookup must pin the channel.
 */

export const CHANNELS = ['whatsapp', 'instagram', 'web'] as const;

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
   *
   * `null` means there is NO window — the business may always reply.
   * That is only true where we own the transport (web), never on a Meta
   * channel. Treat `null` as "always open", never as "zero hours": the
   * two readings are opposites and a `?? 0` here would silently close
   * every web thread.
   */
  replyWindowHours: number | null;
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
  web: {
    // Nothing to pre-approve — we render the UI ourselves, so there is
    // no concept of a template and nothing for one to buy.
    templates: false,
    // Not "unimplemented" — impossible. A web visitor is only reachable
    // while their tab is open, so there is no audience to bulk-send to.
    // This is also why appointment reminders for web-only contacts have
    // to fall back to email.
    broadcasts: false,
    // The first channel where a delivery tick is honest: the SSE frame
    // either reached the visitor's open stream or it did not. WhatsApp
    // reports Meta's opinion; Instagram reports nothing at all.
    deliveryReceipts: true,
    // Both render natively in the widget, so neither is an approximation
    // of something else the way Instagram's quick replies are.
    buttons: true,
    lists: true,
    // Native commerce is a Meta surface. A web storefront is the
    // customer's own site, which the widget sits on rather than replaces.
    catalog: false,
    // No window at all — see the field docs above. We are the transport,
    // so no third party imposes a re-engagement rule.
    replyWindowHours: null,
  },
};

export function capabilitiesFor(channel: Channel): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[channel];
}
