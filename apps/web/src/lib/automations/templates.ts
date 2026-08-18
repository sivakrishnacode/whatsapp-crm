/**
 * The quick-start template catalogue.
 *
 * ⚠️ MIRRORED IN apps/api/src/automations/services/automation-templates.ts.
 *   The web app expands a template CLIENT-side and posts full steps, so
 *   this file is what the gallery actually uses. The API copy serves
 *   `POST /automations { template: '<slug>' }` — the public/partner path,
 *   which never runs this bundle. There is no shared types package yet
 *   (same note as `automation.types.ts`), so change both together. The
 *   API copy carries the data only: `category`, `requirements` and
 *   `highlights` are gallery concerns and stay here.
 *
 * WHAT MAKES A TEMPLATE "WORKING"
 *   Every step that CAN be filled in is filled in — real copy, real
 *   waits, real conditions. What cannot be pre-filled is anything that
 *   names a row in the user's own workspace: a tag id, a pipeline stage,
 *   a Google connection. Those are left EMPTY and declared in
 *   `requirements` instead, so the gallery can say "needs a tag" before
 *   the user opens the builder rather than after they activate it and
 *   nothing happens. Inventing an id would be worse than leaving it
 *   blank: the builder's diagnostics catch a blank, and a fake uuid
 *   saves cleanly and silently never matches.
 */

import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/types';

export type TemplateSlug =
  // Greeting & availability
  | 'welcome_message'
  | 'out_of_office'
  | 'weekend_autoresponder'
  | 'web_chat_greeting'
  // Lead capture
  | 'lead_qualifier'
  | 'pricing_request_router'
  | 'new_lead_to_sheet'
  | 'form_submission_to_deal'
  | 'hot_lead_alert'
  | 'vip_fast_lane'
  // Instagram
  | 'instagram_comment_to_dm'
  | 'instagram_story_reply_thanks'
  // Appointments
  | 'send_booking_link'
  | 'appointment_confirmation'
  | 'appointment_reminder'
  | 'appointment_cancelled_recovery'
  // Support
  | 'support_triage'
  | 'complaint_escalation'
  | 'faq_autoresponder'
  | 'csat_survey'
  // Commerce
  | 'order_status_lookup'
  | 'abandoned_cart_nudge'
  // Follow-up & retention
  | 'follow_up_reminder'
  | 're_engagement_nudge'
  // Ops & integrations
  | 'log_conversation_to_sheet'
  | 'email_lead_summary'
  | 'book_calendar_event';

export type TemplateCategory =
  | 'greeting'
  | 'lead_capture'
  | 'appointments'
  | 'support'
  | 'commerce'
  | 'follow_up'
  | 'integrations';

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: 'greeting', label: 'Greeting & availability' },
  { id: 'lead_capture', label: 'Lead capture' },
  { id: 'appointments', label: 'Appointments' },
  { id: 'support', label: 'Support' },
  { id: 'commerce', label: 'Commerce' },
  { id: 'follow_up', label: 'Follow-up' },
  { id: 'integrations', label: 'Integrations' },
];

/**
 * What a template needs before it can actually run.
 *
 * THREE KINDS, BECAUSE THE FIX IS DIFFERENT FOR EACH
 *   `channel` — the automation only fires on a channel you have
 *               connected. Fixed in Settings → channels.
 *   `app`     — a `google_action` step needs the workspace's Apps Script
 *               bridge. Fixed in Integrations → Google; the gallery
 *               checks this live against `GET /api/google-script`.
 *   `setup`   — a step names something inside this workspace (a tag, a
 *               pipeline stage, a form). Fixed in the builder, and the
 *               only honest thing the gallery can do is say so up front.
 */
export type TemplateRequirementKind = 'channel' | 'app' | 'setup';

export interface TemplateRequirement {
  id: string;
  label: string;
  kind: TemplateRequirementKind;
}

export const REQUIREMENTS = {
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', kind: 'channel' },
  instagram: { id: 'instagram', label: 'Instagram', kind: 'channel' },
  web: { id: 'web', label: 'Web chat', kind: 'channel' },
  /**
   * ONE requirement for all four Google products, not three.
   *
   * Gmail, Calendar, Meet and Sheets arrive through a single Apps Script
   * deployment, so "is Google connected?" has one answer. The predecessor
   * needed one per app because incremental OAuth consent meant a workspace
   * could hold Sheets access and not Gmail — nothing here is granted
   * incrementally.
   */
  google: { id: 'google', label: 'Google', kind: 'app' },
  tag: { id: 'tag', label: 'A tag', kind: 'setup' },
  pipeline: { id: 'pipeline', label: 'A pipeline stage', kind: 'setup' },
  form: { id: 'form', label: 'A published form', kind: 'setup' },
  appointment_type: {
    id: 'appointment_type',
    label: 'An appointment type',
    kind: 'setup',
  },
  api_endpoint: {
    id: 'api_endpoint',
    label: 'Your own API endpoint',
    kind: 'setup',
  },
} satisfies Record<string, TemplateRequirement>;

export type TemplateRequirementId = keyof typeof REQUIREMENTS;

export interface TemplateStepSeed {
  step_type: AutomationStepType;
  step_config: AutomationStepConfig;
  branch?: 'yes' | 'no' | null;
  /** Index (within this seed list) of the Condition parent, if nested. */
  parent_index?: number | null;
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug;
  name: string;
  description: string;
  category: TemplateCategory;
  trigger_type: AutomationTriggerType;
  trigger_config: AutomationTriggerConfig;
  /** Pre-scoped channels. Empty = every channel, the usual default. */
  channels?: string[];
  requirements?: TemplateRequirementId[];
  /** Two or three words each — what the automation does, for the card. */
  highlights?: string[];
  steps: TemplateStepSeed[];
}

export const AUTOMATION_TEMPLATES: Record<
  TemplateSlug,
  AutomationTemplateDefinition
> = {
  // ============================================================
  // Greeting & availability
  // ============================================================

  welcome_message: {
    slug: 'welcome_message',
    name: 'Welcome message',
    description: 'Greet first-time contacts the moment they write in.',
    category: 'greeting',
    // first_inbound_message catches both brand-new contacts AND
    // manually-added/imported contacts on their first-ever reply, which
    // is what a user setting up a "welcome" automation almost always
    // wants. new_contact_created would miss the manually-imported case.
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    requirements: ['tag'],
    highlights: ['Instant reply', 'Tags the contact'],
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
        },
      },
      { step_type: 'add_tag', step_config: { tag_id: '' } },
    ],
  },

  out_of_office: {
    slug: 'out_of_office',
    name: 'Out of office',
    description: 'Reply outside business hours so nobody is left waiting.',
    category: 'greeting',
    trigger_type: 'new_message_received',
    trigger_config: {},
    highlights: ['Off-hours only', 'Sets expectations'],
    steps: [
      {
        step_type: 'condition',
        step_config: {
          match: 'all',
          rules: [{ subject: 'time_of_day', operand: '18:00-09:00' }],
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.',
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },

  weekend_autoresponder: {
    slug: 'weekend_autoresponder',
    name: 'Weekend autoresponder',
    description: 'Tell weekend messages when to expect a human reply.',
    category: 'greeting',
    trigger_type: 'new_message_received',
    trigger_config: {},
    highlights: ['Sat & Sun only', 'Notes the thread'],
    steps: [
      {
        step_type: 'condition',
        step_config: {
          match: 'all',
          rules: [{ subject: 'day_of_week', operand: 'sat,sun' }],
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: "Thanks for writing in! We're closed over the weekend and will reply on Monday morning. If it's urgent, reply URGENT and we'll prioritise it.",
        },
        parent_index: 0,
        branch: 'yes',
      },
      {
        step_type: 'add_note',
        step_config: { text: 'Weekend message — reply Monday.' },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },

  web_chat_greeting: {
    slug: 'web_chat_greeting',
    name: 'Website chat greeting',
    description: 'Welcome website visitors and route them in one tap.',
    category: 'greeting',
    trigger_type: 'web_chat_started',
    trigger_config: {},
    channels: ['web'],
    requirements: ['web'],
    highlights: ['Quick replies', 'Self-routing'],
    steps: [
      {
        step_type: 'send_buttons',
        step_config: {
          body_text: 'Hi there 👋 What can we help you with today?',
          buttons: [
            { id: 'sales', title: 'Talk to sales' },
            { id: 'support', title: 'Get support' },
            { id: 'browsing', title: 'Just browsing' },
          ],
        },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },

  // ============================================================
  // Lead capture
  // ============================================================

  lead_qualifier: {
    slug: 'lead_qualifier',
    name: 'Lead qualifier',
    description: 'Ask a qualifying question, then hand the lead to an agent.',
    category: 'lead_capture',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['pricing', 'quote', 'buy'],
      match_type: 'contains',
    },
    highlights: ['Keyword triggered', 'Round-robin handoff'],
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?',
        },
      },
      { step_type: 'wait', step_config: { amount: 10, unit: 'minutes' } },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },

  pricing_request_router: {
    slug: 'pricing_request_router',
    name: 'Pricing request router',
    description: 'Ask which plan they want, then alert the sales team.',
    category: 'lead_capture',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['price', 'pricing', 'cost', 'how much'],
      match_type: 'contains',
    },
    highlights: ['Segments intent', 'Notifies sales'],
    steps: [
      {
        step_type: 'send_buttons',
        step_config: {
          body_text: 'Happy to help with pricing! Which are you looking at?',
          buttons: [
            { id: 'starter', title: 'Just getting started' },
            { id: 'team', title: 'A whole team' },
            { id: 'enterprise', title: 'Enterprise' },
          ],
        },
      },
      {
        step_type: 'notify_team',
        step_config: {
          recipient: 'all',
          title: 'New pricing enquiry',
          body: '{{ contact.name }} asked about pricing: "{{ message.text }}"',
        },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },

  new_lead_to_sheet: {
    slug: 'new_lead_to_sheet',
    name: 'New lead → Google Sheet',
    description: 'Append every new contact to a spreadsheet as a row.',
    category: 'lead_capture',
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    requirements: ['google'],
    highlights: ['One row per lead', 'No manual entry'],
    steps: [
      {
        step_type: 'google_action',
        step_config: {
          action: 'sheet_append',
          input: {
            // Blank: the author pastes the id from their sheet's URL. There
            // is no picker to prefill it from — nothing lists a customer's
            // files, because that would need a Drive scope.
            spreadsheet_id: '',
            values: [
              '{{ now.date }}',
              '{{ contact.name }}',
              '{{ contact.phone }}',
              '{{ message.text }}',
            ],
          },
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: "Thanks for getting in touch! We've logged your details and someone will follow up shortly.",
        },
      },
    ],
  },

  form_submission_to_deal: {
    slug: 'form_submission_to_deal',
    name: 'Form submission → deal',
    description: 'Open a deal and alert the team when a form comes in.',
    category: 'lead_capture',
    trigger_type: 'form_submitted',
    trigger_config: {},
    requirements: ['form', 'pipeline'],
    highlights: ['Creates a deal', 'Notifies the team'],
    steps: [
      {
        step_type: 'create_deal',
        step_config: {
          pipeline_id: '',
          stage_id: '',
          title: 'Form lead — {{ contact.name }}',
          value: 0,
        },
      },
      {
        step_type: 'notify_team',
        step_config: {
          recipient: 'all',
          title: 'New form submission',
          body: '{{ contact.name }} submitted a form. Deal {{ steps.create_deal.deal_id }} created.',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: "Thanks for filling that in! We've got everything we need and will be in touch soon.",
        },
      },
    ],
  },

  hot_lead_alert: {
    slug: 'hot_lead_alert',
    name: 'Hot lead alert',
    description: 'Ping the team the second someone signals buying intent.',
    category: 'lead_capture',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['demo', 'trial', 'buy now', 'sign up', 'invoice'],
      match_type: 'contains',
    },
    highlights: ['Instant alert', 'Marks the thread'],
    steps: [
      {
        step_type: 'notify_team',
        step_config: {
          recipient: 'all',
          title: '🔥 Hot lead',
          body: '{{ contact.name }} said: "{{ message.text }}"',
        },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: "Love it — putting you with someone right now. Give us a couple of minutes and you'll hear from a real person.",
        },
      },
      {
        step_type: 'set_conversation_status',
        step_config: { status: 'open' },
      },
    ],
  },

  vip_fast_lane: {
    slug: 'vip_fast_lane',
    name: 'VIP fast lane',
    description:
      'Jump tagged VIP customers straight to the front of the queue.',
    category: 'lead_capture',
    trigger_type: 'new_message_received',
    trigger_config: {},
    requirements: ['tag'],
    highlights: ['Tag-gated', 'Priority routing'],
    steps: [
      {
        step_type: 'condition',
        step_config: {
          match: 'all',
          rules: [{ subject: 'tag_presence', operand: '', operator: 'equals' }],
        },
      },
      {
        step_type: 'notify_team',
        step_config: {
          recipient: 'all',
          title: 'VIP is waiting',
          body: '{{ contact.name }} (VIP) just messaged.',
        },
        parent_index: 0,
        branch: 'yes',
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },

  // ============================================================
  // Instagram
  // ============================================================

  instagram_comment_to_dm: {
    slug: 'instagram_comment_to_dm',
    name: 'Comment → DM',
    description: 'Turn a comment on your post into a private conversation.',
    category: 'lead_capture',
    trigger_type: 'instagram_comment',
    trigger_config: {
      keywords: ['price', 'link', 'info'],
      match_type: 'contains',
    },
    channels: ['instagram'],
    requirements: ['instagram'],
    highlights: ['Public → private', 'Keyword filtered'],
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Hey! Thanks for commenting 🙌 Sending the details right here — what would you like to know first?',
        },
      },
      { step_type: 'add_tag', step_config: { tag_id: '' } },
    ],
  },

  instagram_story_reply_thanks: {
    slug: 'instagram_story_reply_thanks',
    name: 'Story reply thank-you',
    description: 'Answer story replies while the interest is still fresh.',
    category: 'lead_capture',
    trigger_type: 'instagram_story_reply',
    trigger_config: {},
    channels: ['instagram'],
    requirements: ['instagram'],
    highlights: ['Replies in seconds', 'Offers a next step'],
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'Thanks for replying to our story! 💛 Want me to send over the details?',
        },
      },
      { step_type: 'wait', step_config: { amount: 30, unit: 'minutes' } },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },

  // ============================================================
  // Appointments
  // ============================================================

  send_booking_link: {
    slug: 'send_booking_link',
    name: 'Send a booking link',
    description: 'Offer a slot picker whenever someone asks to meet.',
    category: 'appointments',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['book', 'appointment', 'meeting', 'call'],
      match_type: 'contains',
    },
    requirements: ['appointment_type'],
    highlights: ['Self-serve booking', 'No back-and-forth'],
    steps: [
      {
        step_type: 'send_booking_link',
        step_config: {
          appointment_type_id: '',
          message_text: 'Sure — pick any slot that suits you:',
        },
      },
      { step_type: 'wait', step_config: { amount: 1, unit: 'days' } },
      {
        step_type: 'send_message',
        step_config: {
          text: "Just checking you managed to grab a time — shout if none of the slots work and we'll find another.",
        },
      },
    ],
  },

  appointment_confirmation: {
    slug: 'appointment_confirmation',
    name: 'Booking confirmation',
    description: 'Confirm a new booking and log it on the contact.',
    category: 'appointments',
    trigger_type: 'appointment_booked',
    trigger_config: {},
    highlights: ['Confirms instantly', 'Notes the timeline'],
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "You're booked in — thank you! 🎉 We'll send a reminder before it starts. Reply here if you need to change anything.",
        },
      },
      {
        step_type: 'add_note',
        step_config: { text: 'Appointment booked via automation.' },
      },
    ],
  },

  appointment_reminder: {
    slug: 'appointment_reminder',
    name: 'Appointment reminder',
    description: 'Nudge the day before so fewer people forget to turn up.',
    category: 'appointments',
    trigger_type: 'appointment_booked',
    trigger_config: {},
    highlights: ['Cuts no-shows', 'One-tap reschedule'],
    steps: [
      { step_type: 'wait', step_config: { amount: 1, unit: 'days' } },
      {
        step_type: 'send_buttons',
        step_config: {
          body_text:
            'Quick reminder about your upcoming appointment — are we still good to go?',
          buttons: [
            { id: 'confirm', title: "Yes, I'll be there" },
            { id: 'reschedule', title: 'Need to reschedule' },
          ],
        },
      },
    ],
  },

  appointment_cancelled_recovery: {
    slug: 'appointment_cancelled_recovery',
    name: 'Cancellation recovery',
    description: 'Win back a cancelled booking instead of losing the lead.',
    category: 'appointments',
    trigger_type: 'appointment_cancelled',
    trigger_config: {},
    requirements: ['appointment_type'],
    highlights: ['Offers a rebook', 'Alerts the owner'],
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: 'No problem at all — thanks for letting us know. Want to pick another time?',
        },
      },
      {
        step_type: 'send_booking_link',
        step_config: {
          appointment_type_id: '',
          message_text: 'Here are the next available slots:',
        },
      },
      {
        step_type: 'notify_team',
        step_config: {
          recipient: 'all',
          title: 'Appointment cancelled',
          body: '{{ contact.name }} cancelled — rebooking link sent.',
        },
      },
    ],
  },

  // ============================================================
  // Support
  // ============================================================

  support_triage: {
    slug: 'support_triage',
    name: 'Support triage',
    description: 'Acknowledge the issue, queue it, and assign an agent.',
    category: 'support',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['help', 'issue', 'problem', 'not working', 'support'],
      match_type: 'contains',
    },
    highlights: ['Acknowledges fast', 'Queues the thread'],
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Sorry you've hit a snag! 🙏 A member of the support team is picking this up — could you describe what you were doing when it happened?",
        },
      },
      {
        step_type: 'set_conversation_status',
        step_config: { status: 'pending' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },

  complaint_escalation: {
    slug: 'complaint_escalation',
    name: 'Complaint escalation',
    description: 'Catch refund and cancellation language before it escalates.',
    category: 'support',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['refund', 'cancel', 'complaint', 'terrible', 'lawyer'],
      match_type: 'contains',
    },
    highlights: ['Escalates on sight', 'Leaves an audit note'],
    steps: [
      {
        step_type: 'notify_team',
        step_config: {
          recipient: 'all',
          title: '⚠️ Escalation',
          body: '{{ contact.name }}: "{{ message.text }}"',
        },
      },
      {
        step_type: 'add_note',
        step_config: {
          text: 'Auto-escalated — message matched a complaint keyword.',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: "I'm really sorry about this. I've flagged it to a senior member of the team and they'll come back to you personally.",
        },
      },
      {
        step_type: 'set_conversation_status',
        step_config: { status: 'open' },
      },
    ],
  },

  faq_autoresponder: {
    slug: 'faq_autoresponder',
    name: 'FAQ autoresponder',
    description: 'Answer the questions you get twenty times a day.',
    category: 'support',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['hours', 'open', 'address', 'location', 'where are you'],
      match_type: 'contains',
    },
    highlights: ['Deflects repeats', 'Menu of answers'],
    steps: [
      {
        step_type: 'send_list',
        step_config: {
          body_text: 'Here are the things people usually ask — tap one:',
          button_label: 'View answers',
          sections: [
            {
              title: 'Common questions',
              rows: [
                { id: 'hours', title: 'Opening hours' },
                { id: 'location', title: 'Where to find us' },
                { id: 'delivery', title: 'Delivery times' },
                { id: 'human', title: 'Talk to a person' },
              ],
            },
          ],
        },
      },
    ],
  },

  csat_survey: {
    slug: 'csat_survey',
    name: 'Satisfaction survey',
    description: 'Ask how it went once a conversation is marked resolved.',
    category: 'support',
    trigger_type: 'tag_added',
    trigger_config: { tag_id: '' },
    requirements: ['tag'],
    highlights: ['Fires on resolve', 'One-tap rating'],
    steps: [
      { step_type: 'wait', step_config: { amount: 1, unit: 'hours' } },
      {
        step_type: 'send_buttons',
        step_config: {
          body_text: 'How did we do today?',
          buttons: [
            { id: 'great', title: '😀 Great' },
            { id: 'ok', title: '😐 Okay' },
            { id: 'bad', title: '🙁 Not good' },
          ],
        },
      },
    ],
  },

  // ============================================================
  // Commerce
  // ============================================================

  order_status_lookup: {
    slug: 'order_status_lookup',
    name: 'Order status lookup',
    description: 'Call your own API and answer "where is my order?" instantly.',
    category: 'commerce',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['order', 'tracking', 'where is my'],
      match_type: 'contains',
    },
    requirements: ['api_endpoint'],
    highlights: ['Live lookup', 'Branches on failure'],
    steps: [
      {
        step_type: 'http_request',
        step_config: {
          method: 'GET',
          url: 'https://example.com/api/orders?phone={{ contact.phone }}',
          headers: {},
          query: {},
          body_mode: 'none',
          timeout_seconds: 10,
          // A 404 from "does this order exist?" is an ANSWER, so the run
          // must reach the condition below rather than stop here.
          ignore_http_errors: true,
          on_error: 'continue',
        },
      },
      {
        step_type: 'condition',
        step_config: {
          match: 'all',
          rules: [
            {
              subject: 'expression',
              operand: 'steps.http_request.ok',
              operator: 'equals',
              value: 'true',
            },
          ],
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Found it! Your order is currently: {{ steps.http_request.body.status }}',
        },
        parent_index: 1,
        branch: 'yes',
      },
      {
        step_type: 'send_message',
        step_config: {
          text: "I couldn't find an order against this number — could you send me the order reference?",
        },
        parent_index: 1,
        branch: 'no',
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
        parent_index: 1,
        branch: 'no',
      },
    ],
  },

  abandoned_cart_nudge: {
    slug: 'abandoned_cart_nudge',
    name: 'Abandoned cart nudge',
    description: 'Follow up on an abandoned basket, then stop politely.',
    category: 'commerce',
    trigger_type: 'tag_added',
    trigger_config: { tag_id: '' },
    requirements: ['tag'],
    highlights: ['Two-touch sequence', 'Stops after one nudge'],
    steps: [
      { step_type: 'wait', step_config: { amount: 4, unit: 'hours' } },
      {
        step_type: 'send_message',
        step_config: {
          text: 'You left a few things in your basket 🛒 Want me to hold them for you?',
        },
      },
      { step_type: 'wait', step_config: { amount: 1, unit: 'days' } },
      {
        step_type: 'send_message',
        step_config: {
          text: "Last nudge from us — your basket is still saved if you'd like it. Either way, have a great day!",
        },
      },
      { step_type: 'remove_tag', step_config: { tag_id: '' } },
    ],
  },

  // ============================================================
  // Follow-up
  // ============================================================

  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: 'Follow-up reminder',
    description: 'Circle back a day later if the thread went quiet.',
    category: 'follow_up',
    trigger_type: 'new_message_received',
    trigger_config: {},
    highlights: ['24-hour nudge', 'Keeps deals warm'],
    steps: [
      { step_type: 'wait', step_config: { amount: 1, unit: 'days' } },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Just circling back — did you have any other questions for us? Happy to help!',
        },
      },
    ],
  },

  re_engagement_nudge: {
    slug: 're_engagement_nudge',
    name: 'Win-back nudge',
    description: 'Wake up contacts you have tagged as gone quiet.',
    category: 'follow_up',
    trigger_type: 'tag_added',
    trigger_config: { tag_id: '' },
    requirements: ['tag'],
    highlights: ['A/B tested copy', 'Tag triggered'],
    steps: [
      { step_type: 'random_split', step_config: { percent: 50 } },
      {
        step_type: 'send_message',
        step_config: {
          text: "It's been a while! We've shipped a lot since we last spoke — want the two-minute version?",
        },
        parent_index: 0,
        branch: 'yes',
      },
      {
        step_type: 'send_message',
        step_config: {
          text: 'Hey! Anything we can help with? Reply here and a real person will pick it up.',
        },
        parent_index: 0,
        branch: 'no',
      },
    ],
  },

  // ============================================================
  // Ops & integrations
  // ============================================================

  log_conversation_to_sheet: {
    slug: 'log_conversation_to_sheet',
    name: 'Log conversations to Sheets',
    description: 'Keep a running spreadsheet of every inbound message.',
    category: 'integrations',
    trigger_type: 'new_message_received',
    trigger_config: {},
    requirements: ['google'],
    highlights: ['Row per message', 'Reportable history'],
    steps: [
      {
        step_type: 'google_action',
        step_config: {
          action: 'sheet_append',
          input: {
            spreadsheet_id: '',
            values: [
              '{{ now.iso }}',
              '{{ contact.name }}',
              '{{ contact.phone }}',
              '{{ conversation.channel }}',
              '{{ message.text }}',
            ],
          },
          // A logging step must never cancel the customer-facing steps
          // that follow it. Sheets being slow is our problem, not theirs.
          on_error: 'continue',
        },
      },
    ],
  },

  email_lead_summary: {
    slug: 'email_lead_summary',
    name: 'Email the lead to your team',
    description: 'Send a Gmail summary whenever a new lead writes in.',
    category: 'integrations',
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    requirements: ['google'],
    highlights: ['Sends via Gmail', 'Full first message'],
    steps: [
      {
        step_type: 'google_action',
        step_config: {
          action: 'send_email',
          input: {
            to: [''],
            subject: 'New lead: {{ contact.name }}',
            body: 'Channel: {{ conversation.channel }}\nPhone: {{ contact.phone }}\n\nThey said:\n{{ message.text }}',
          },
          on_error: 'continue',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: "Thanks for reaching out! We've passed this to the right person and they'll reply shortly.",
        },
      },
    ],
  },

  book_calendar_event: {
    slug: 'book_calendar_event',
    name: 'Create a calendar event',
    description: 'Put a follow-up call on Google Calendar when a lead asks.',
    category: 'integrations',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['schedule', 'calendar', 'call me'],
      match_type: 'contains',
    },
    requirements: ['google'],
    highlights: ['Writes to Calendar', 'Confirms in chat'],
    steps: [
      {
        step_type: 'google_action',
        step_config: {
          action: 'create_event',
          input: {
            // `title`, not `summary`: the bridge's field name. A stale key
            // would save and then fail activation as a missing required
            // field, which is the catalogue doing its job.
            title: 'Follow-up call — {{ contact.name }}',
            description: 'Requested in chat: {{ message.text }}',
            add_meet: true,
            // Blank on purpose, and activation will say so: only the author
            // knows when the call should be. A template that guessed a time
            // would put real events in real diaries at the wrong hour.
            starts_at: '',
            ends_at: '',
          },
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: "Done — I've put a call in the diary. You'll get the details by email.",
        },
      },
    ],
  },
};

export const TEMPLATE_SLUGS = Object.keys(
  AUTOMATION_TEMPLATES
) as TemplateSlug[];

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null;
}

export function templateRequirements(
  template: AutomationTemplateDefinition
): TemplateRequirement[] {
  return (template.requirements ?? []).map((id) => REQUIREMENTS[id]);
}

/** How many steps a template lays down, counting both branches. */
export function templateStepCount(
  template: AutomationTemplateDefinition
): number {
  return template.steps.length;
}
