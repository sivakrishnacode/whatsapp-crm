/**
 * Can this step actually run, given the automation's trigger and
 * channels?
 *
 * WHY THE EDITOR HAS TO ANSWER THIS
 *   The engine already answers it at run time — an unsupported step
 *   raises `UnsupportedOnChannelError` and is SKIPPED so the rest of the
 *   run continues. That is the right run-time behaviour and a terrible
 *   authoring experience: an Instagram-only automation with a Send
 *   template step saves, activates, shows no error, and quietly does
 *   nothing. The author finds out from a customer.
 *
 * THREE ANSWERS, NOT TWO
 *   `ok`      — runs everywhere this automation can fire.
 *   `partial` — runs on some of the selected channels and is skipped on
 *               the others. Legitimate and common: one automation that
 *               sends a template on WhatsApp and plain text on Instagram
 *               is the whole reason the `channel` condition exists.
 *   `never`   — cannot run on ANY selected channel, or the trigger
 *               cannot supply what the step needs. This is dead config.
 *
 * MIRRORS `CHANNEL_CAPABILITIES` in
 * apps/api/src/common/messaging/channel.ts. That file is the authority;
 * if the two disagree, this one is the bug.
 */

import { STEP_META } from '@/lib/automations/step-meta';
import type { AutomationStepType, AutomationTriggerType } from '@/types';

export const CHANNELS = ['whatsapp', 'instagram', 'web'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  web: 'Web chat',
};

interface Capabilities {
  templates: boolean;
  buttons: boolean;
  lists: boolean;
}

const CAPABILITIES: Record<Channel, Capabilities> = {
  whatsapp: { templates: true, buttons: true, lists: true },
  instagram: {
    // Instagram has no template mechanism at all — not "unimplemented",
    // absent. Quick replies are a genuine equivalent of buttons; there
    // is no list message to approximate.
    templates: false,
    buttons: true,
    lists: false,
  },
  web: {
    // Nothing to pre-approve: we render the widget ourselves, so there
    // is no concept of a template.
    templates: false,
    buttons: true,
    lists: true,
  },
};

/**
 * Which capability a step needs, if any.
 *
 * `app_action` is deliberately absent, as are `http_request` and the
 * data steps: they send nothing through a channel, so no channel can
 * fail to support them. A Google Sheets row is appended identically
 * whether the trigger came from WhatsApp, Instagram or a form.
 */
const STEP_REQUIRES: Partial<Record<AutomationStepType, keyof Capabilities>> = {
  send_template: 'templates',
  send_buttons: 'buttons',
  send_list: 'lists',
};

/**
 * Steps that need somebody to talk to.
 *
 * They resolve a conversation and are skipped when there is none — a
 * hosted form submission or a scheduled run has no thread.
 */
const NEEDS_CONVERSATION = new Set<AutomationStepType>([
  'send_message',
  'send_template',
  'send_media',
  'send_buttons',
  'send_list',
  'send_form',
  'send_booking_link',
  'start_flow',
  'assign_conversation',
  'close_conversation',
  'set_conversation_status',
]);

/**
 * Steps that need to know WHO the run is about.
 *
 * Separate from the above because the failure differs: without a contact
 * these throw rather than skip, and a scheduled automation has no
 * contact at all.
 */
const NEEDS_CONTACT = new Set<AutomationStepType>([
  ...NEEDS_CONVERSATION,
  'add_tag',
  'remove_tag',
  'add_to_segment',
  'remove_from_segment',
  'update_contact_field',
  'add_note',
  'update_deal',
]);

/**
 * Triggers that fire without a person attached.
 *
 * `time_based` is the honest case: a schedule fires for the workspace,
 * not for a contact, so every contact-shaped step in it is dead.
 */
const TRIGGERS_WITHOUT_CONTACT = new Set<AutomationTriggerType>(['time_based']);

/**
 * Triggers that can fire for someone who has never been in a chat.
 *
 * A hosted form submission or a booking made on a public page creates or
 * matches a contact with no conversation on any channel. Send steps are
 * then skipped — which is correct, and worth saying out loud, because
 * the tag and deal steps beside them do run.
 */
const TRIGGERS_WITHOUT_CONVERSATION = new Set<AutomationTriggerType>([
  'form_submitted',
  'appointment_booked',
  'appointment_cancelled',
  'appointment_rescheduled',
]);

export type AvailabilityStatus = 'ok' | 'partial' | 'never';

export interface Availability {
  status: AvailabilityStatus;
  /** One sentence, written for the person who has to fix it. */
  reason?: string;
  /** Channels this step cannot run on, of those selected. */
  unsupported: Channel[];
}

/**
 * `channels` empty means every channel — both the default and what every
 * automation predating the column does. That is why "supported on at
 * least one" is evaluated against the full list in that case: a Send
 * template step in an unscoped automation is fine, because a WhatsApp
 * message can trigger it.
 */
export function stepAvailability(
  type: AutomationStepType,
  channels: string[],
  trigger: AutomationTriggerType,
): Availability {
  const scoped = (
    channels.length > 0 ? channels : [...CHANNELS]
  ).filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c));

  // --- What the trigger can supply ---------------------------------

  if (TRIGGERS_WITHOUT_CONTACT.has(trigger) && NEEDS_CONTACT.has(type)) {
    return {
      status: 'never',
      unsupported: scoped,
      reason:
        'A scheduled automation runs for the workspace, not for one person, so this step has nobody to act on.',
    };
  }

  if (
    TRIGGERS_WITHOUT_CONVERSATION.has(trigger) &&
    NEEDS_CONVERSATION.has(type)
  ) {
    return {
      status: 'partial',
      unsupported: [],
      reason:
        'If this person has never messaged you, there is no thread to send on and this step is skipped — the rest of the automation still runs.',
    };
  }

  // --- What the channel can do -------------------------------------

  const required = STEP_REQUIRES[type];
  if (!required) return { status: 'ok', unsupported: [] };

  const unsupported = scoped.filter((c) => !CAPABILITIES[c][required]);
  if (unsupported.length === 0) return { status: 'ok', unsupported: [] };

  // UNSCOPED AUTOMATIONS ARE NOT WARNED ABOUT PARTIAL SUPPORT.
  //
  // An empty channel list means "every channel", so strictly a template
  // step in one IS skipped on Instagram and web. Saying so would put a
  // warning on essentially every template step in the product — most
  // accounts have only WhatsApp connected and never touch the picker —
  // and a warning that is always there is a warning nobody reads.
  //
  // A step that works NOWHERE is still reported: that is not noise, it
  // is dead configuration.
  if (channels.length === 0 && unsupported.length < scoped.length) {
    return { status: 'ok', unsupported: [] };
  }

  const names = unsupported.map((c) => CHANNEL_LABELS[c]).join(' or ');
  const label = STEP_META[type]?.label ?? type;

  if (unsupported.length === scoped.length) {
    return {
      status: 'never',
      unsupported,
      reason:
        required === 'templates'
          ? `${names} has no templates at all, so this step can never run in this automation.`
          : `${label} is not available on ${names}, so this step can never run in this automation.`,
    };
  }

  return {
    status: 'partial',
    unsupported,
    reason: `Skipped on ${names}. The rest of the automation still runs there.`,
  };
}

/**
 * Whether a step type is offerable at all for these channels — used to
 * dim it in the add menu.
 *
 * Dimmed WITH A REASON rather than hidden: a step missing from a menu
 * reads as a bug, whereas a greyed-out one that explains itself is a
 * rule you learn once. Same call the segment picker makes for dynamic
 * segments.
 */
export function addMenuAvailability(
  type: AutomationStepType,
  channels: string[],
  trigger: AutomationTriggerType,
): Availability {
  return stepAvailability(type, channels, trigger);
}
