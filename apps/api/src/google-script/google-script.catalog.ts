/**
 * The action catalogue — the one authority for what the bridge can do.
 *
 * Served to the web app by `GET /google-script/catalog`, which is also
 * what the API validates step configs against, so a field cannot render
 * in the editor without being validated on the way in.
 *
 * ⚠️ EVERY ID AND FIELD KEY HERE IS A WIRE CONTRACT WITH SCRIPTS ALREADY
 *    DEPLOYED IN CUSTOMERS' GOOGLE ACCOUNTS.
 *
 *   The old OAuth connector could add an action server-side and every
 *   workspace had it instantly. Here the other half of the contract lives
 *   in a script we cannot update (see docs/google-apps-script.md, "no
 *   update channel"). So:
 *
 *     - ADDING an action means every customer must re-paste the script
 *       before that action works. Ship it with a version check, not
 *       silently.
 *     - RENAMING an id or a field key breaks live automations against
 *       already-deployed scripts, which fail with "unknown action" and no
 *       way for the customer to tell why.
 *
 *   `BRIDGE_VERSION` is bumped whenever this list changes; the bridge
 *   echoes its own version so the Integrations page can tell a customer
 *   their script is behind.
 *
 * ⚠️ THERE IS NO `create_meet` ACTION, AND THAT IS DELIBERATE. Verified
 *    against a live deployment: a standalone Meet space needs the Google
 *    Meet API enabled on the script's GCP project, and an Apps Script
 *    project's *default* GCP project will not allow that — it 403s. The
 *    fix would be making every customer attach a standard GCP project.
 *    `create_event` with `add_meet` returns a real `meeting_url` through
 *    the Calendar API instead, with no setup at all, which is why Meet
 *    needs no action and no scope of its own.
 */

import type { GoogleScriptAction } from './google-script.types';

/**
 * Bumped when an action or field changes. The deployed script reports the
 * version it was generated with; a mismatch is shown as "your script is
 * out of date" rather than left to fail as an unknown action.
 */
export const BRIDGE_VERSION = 2;

const RECIPIENT_HELP =
  'One address, or several separated by commas. Tokens like {{ contact.email }} work.';

export const GOOGLE_SCRIPT_ACTIONS: GoogleScriptAction[] = [
  {
    id: 'send_email',
    service: 'gmail',
    label: 'Send email',
    description: "Send from the connected Google account's own address.",
    irreversible: true,
    outputs: ['to'],
    inputs: [
      {
        key: 'to',
        label: 'To',
        kind: 'email_list',
        required: true,
        tokens: true,
        help: RECIPIENT_HELP,
        placeholder: '{{ contact.email }}',
      },
      {
        key: 'subject',
        label: 'Subject',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: 'Thanks for getting in touch, {{ contact.name }}',
      },
      { key: 'body', label: 'Message', kind: 'long_text', required: true, tokens: true },
      {
        key: 'html',
        label: 'Send as HTML',
        kind: 'boolean',
        default: false,
        help: 'Off sends plain text, which is what most confirmations want.',
      },
      { key: 'cc', label: 'Cc', kind: 'email_list', tokens: true },
      { key: 'bcc', label: 'Bcc', kind: 'email_list', tokens: true },
      {
        key: 'reply_to',
        label: 'Reply-To',
        kind: 'text',
        tokens: true,
        help: 'Where replies should land, if not the sending address.',
      },
      { key: 'from_name', label: 'From name', kind: 'text', tokens: true },
      {
        key: 'attachments',
        label: 'Attachments',
        kind: 'value_list',
        tokens: true,
        help: 'Up to 5 file URLs — paste from Media, or use a token from an earlier step.',
      },
    ],
  },

  /**
   * ⚠️ No `send_reply`. Threading a reply needs a thread id from an
   * earlier send, and there is no way to search a mailbox for one:
   * `gmail.readonly` is Google-RESTRICTED. The bridge is send-only for
   * the same reason the OAuth connector was.
   */

  {
    id: 'create_event',
    service: 'calendar',
    label: 'Create calendar event',
    description: 'Book a slot, optionally with a Google Meet link.',
    irreversible: true,
    outputs: ['event_id', 'html_link', 'meeting_url'],
    inputs: [
      {
        key: 'title',
        label: 'Title',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: 'Consultation with {{ contact.name }}',
      },
      {
        key: 'starts_at',
        label: 'Starts',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: '2026-08-20T15:00:00+05:30',
        help: 'ISO 8601, including the offset. A bare date has no time to book.',
      },
      {
        key: 'ends_at',
        label: 'Ends',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: '2026-08-20T15:30:00+05:30',
      },
      {
        key: 'add_meet',
        label: 'Add a Google Meet link',
        kind: 'boolean',
        default: true,
        help: 'Returns meeting_url, which a later step can send to the customer.',
      },
      { key: 'description', label: 'Description', kind: 'long_text', tokens: true },
      {
        key: 'attendees',
        label: 'Attendees',
        kind: 'email_list',
        tokens: true,
        help: RECIPIENT_HELP,
      },
      {
        key: 'timezone',
        label: 'Timezone',
        kind: 'text',
        tokens: false,
        placeholder: 'Asia/Kolkata',
        help: "Blank uses the script's own timezone.",
      },
      {
        key: 'notify',
        label: 'Email the attendees',
        kind: 'select',
        tokens: false,
        default: 'none',
        options: [
          { value: 'none', label: 'No notifications' },
          { value: 'all', label: 'Yes, notify everyone' },
          { value: 'externalOnly', label: 'Only people outside the org' },
        ],
      },
    ],
  },
  {
    id: 'update_event',
    service: 'calendar',
    label: 'Reschedule an event',
    description: 'Move or edit an event booked earlier. Send only what changes.',
    irreversible: true,
    outputs: ['event_id', 'html_link', 'meeting_url'],
    inputs: [
      {
        key: 'event_id',
        label: 'Event id',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: '{{ steps.book.event_id }}',
        help: 'From the Create calendar event step that made it. Nothing searches your calendar for one.',
      },
      { key: 'starts_at', label: 'New start', kind: 'text', tokens: true },
      { key: 'ends_at', label: 'New end', kind: 'text', tokens: true },
      { key: 'title', label: 'New title', kind: 'text', tokens: true },
      { key: 'description', label: 'New description', kind: 'long_text', tokens: true },
      { key: 'timezone', label: 'Timezone', kind: 'text', tokens: false },
      {
        key: 'notify',
        label: 'Tell the attendees',
        kind: 'select',
        tokens: false,
        default: 'all',
        options: [
          { value: 'all', label: 'Yes, notify everyone' },
          { value: 'externalOnly', label: 'Only people outside the org' },
          { value: 'none', label: 'No notifications' },
        ],
      },
    ],
  },
  {
    id: 'delete_event',
    service: 'calendar',
    label: 'Cancel an event',
    description: 'Take an event off the calendar. Already gone counts as success.',
    irreversible: true,
    outputs: ['deleted'],
    inputs: [
      {
        key: 'event_id',
        label: 'Event id',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: '{{ steps.book.event_id }}',
      },
      {
        key: 'notify',
        label: 'Tell the attendees',
        kind: 'select',
        tokens: false,
        default: 'all',
        options: [
          { value: 'all', label: 'Yes' },
          { value: 'none', label: 'No' },
        ],
      },
    ],
  },
  {
    id: 'find_events',
    service: 'calendar',
    label: 'Find events',
    description: "What's on between two instants. Reads titles and times.",
    outputs: ['events', 'count'],
    inputs: [
      {
        key: 'from',
        label: 'From',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: '{{ now.iso }}',
      },
      { key: 'to', label: 'To', kind: 'text', required: true, tokens: true },
      {
        key: 'query',
        label: 'Containing',
        kind: 'text',
        tokens: true,
        help: 'Optional free-text match on the event.',
      },
      {
        key: 'max',
        label: 'Most to return',
        kind: 'number',
        tokens: false,
        default: 10,
      },
    ],
  },
  {
    id: 'check_availability',
    service: 'calendar',
    label: 'Check availability',
    description: 'Busy blocks between two instants. Reads no event details.',
    outputs: ['busy'],
    inputs: [
      {
        key: 'from',
        label: 'From',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: '2026-08-20T00:00:00+05:30',
      },
      {
        key: 'to',
        label: 'To',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: '2026-08-21T00:00:00+05:30',
      },
    ],
  },

  {
    id: 'sheet_append',
    service: 'sheets',
    label: 'Add a row',
    description: 'Append a row to a spreadsheet the workspace supplies.',
    irreversible: true,
    outputs: ['row'],
    inputs: [
      {
        key: 'spreadsheet_id',
        label: 'Spreadsheet',
        kind: 'text',
        required: true,
        tokens: false,
        help: 'The id from the sheet URL: docs.google.com/spreadsheets/d/THIS-PART/edit',
      },
      {
        key: 'tab',
        label: 'Tab',
        kind: 'text',
        tokens: false,
        placeholder: 'Leads',
        help: "Blank uses the first tab. Nothing lists your tabs — we hold no Drive access.",
      },
      {
        key: 'values',
        label: 'Values',
        kind: 'value_list',
        required: true,
        tokens: true,
        placeholder: '{{ contact.name }}, {{ contact.phone }}, {{ now }}',
        help: 'Left to right, one per column.',
      },
    ],
  },
  {
    id: 'sheet_find',
    service: 'sheets',
    label: 'Find a row',
    description: 'Look up a row by a column value. Publishes what it found.',
    outputs: ['found', 'row', 'values'],
    inputs: [
      { key: 'spreadsheet_id', label: 'Spreadsheet', kind: 'text', required: true, tokens: false },
      { key: 'tab', label: 'Tab', kind: 'text', tokens: false, placeholder: 'Leads' },
      {
        key: 'column',
        label: 'Search column',
        kind: 'text',
        required: true,
        tokens: false,
        help: 'The header text in row 1 — the first row is always treated as headers.',
      },
      { key: 'value', label: 'Search for', kind: 'text', required: true, tokens: true },
    ],
  },
  {
    id: 'sheet_update',
    service: 'sheets',
    label: 'Update a row',
    description: 'Find a row by a column value and overwrite it.',
    irreversible: true,
    outputs: ['found', 'row'],
    inputs: [
      { key: 'spreadsheet_id', label: 'Spreadsheet', kind: 'text', required: true, tokens: false },
      { key: 'tab', label: 'Tab', kind: 'text', tokens: false, placeholder: 'Leads' },
      { key: 'column', label: 'Search column', kind: 'text', required: true, tokens: false },
      { key: 'value', label: 'Search for', kind: 'text', required: true, tokens: true },
      {
        key: 'values',
        label: 'New values',
        kind: 'value_list',
        required: true,
        tokens: true,
        help: 'Replaces the whole row, left to right. Repeat unchanged cells.',
      },
    ],
  },
  {
    id: 'sheet_delete_row',
    service: 'sheets',
    label: 'Delete a row',
    description: 'Find a row by a column value and remove it.',
    irreversible: true,
    outputs: ['found', 'row'],
    inputs: [
      { key: 'spreadsheet_id', label: 'Spreadsheet', kind: 'text', required: true, tokens: false },
      { key: 'tab', label: 'Tab', kind: 'text', tokens: false, placeholder: 'Leads' },
      { key: 'column', label: 'Search column', kind: 'text', required: true, tokens: false },
      { key: 'value', label: 'Search for', kind: 'text', required: true, tokens: true },
    ],
  },
  /* ------------------------------------------------------------------
   * Tier 1 — one new scope each, all verified NON-restricted against
   * Google's current restricted list (which is Gmail, Drive, Fit, Chat,
   * Data Portability, Photos Ambient and Health). Adding these costs every
   * customer a re-paste AND a re-authorize, which is why they ship in one
   * version bump rather than one at a time.
   * ------------------------------------------------------------------ */

  {
    id: 'contact_save',
    service: 'contacts',
    label: 'Save to Google Contacts',
    description: "Put the person in the account's own address book, so they show up on the phone.",
    irreversible: true,
    outputs: ['resource_name', 'created'],
    inputs: [
      {
        key: 'name',
        label: 'Name',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: '{{ contact.name }}',
      },
      {
        key: 'phone',
        label: 'Phone',
        kind: 'text',
        tokens: true,
        placeholder: '{{ contact.phone }}',
        help: 'Also what an existing entry is matched on, so a re-run updates rather than duplicates.',
      },
      { key: 'email', label: 'Email', kind: 'text', tokens: true },
      { key: 'company', label: 'Company', kind: 'text', tokens: true },
      { key: 'notes', label: 'Notes', kind: 'long_text', tokens: true },
    ],
  },

  {
    id: 'create_doc',
    service: 'docs',
    label: 'Create a document',
    description: 'Write a quote, receipt or summary and get a link back.',
    irreversible: true,
    outputs: ['document_id', 'url'],
    inputs: [
      {
        key: 'title',
        label: 'Title',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: 'Quote for {{ contact.name }}',
      },
      {
        key: 'body',
        label: 'Contents',
        kind: 'long_text',
        required: true,
        tokens: true,
        help: 'Plain text. Tokens are filled in before the document is written.',
      },
    ],
  },

  {
    id: 'create_task',
    service: 'tasks',
    label: 'Add a task',
    description: "Put a follow-up on the account's own Google Tasks list.",
    irreversible: true,
    outputs: ['task_id'],
    inputs: [
      {
        key: 'title',
        label: 'Task',
        kind: 'text',
        required: true,
        tokens: true,
        placeholder: 'Call {{ contact.name }} back',
      },
      { key: 'notes', label: 'Notes', kind: 'long_text', tokens: true },
      {
        key: 'due',
        label: 'Due date',
        kind: 'text',
        tokens: true,
        placeholder: '2026-08-25',
        help: 'A date, not a time — Google Tasks ignores the time of day.',
      },
    ],
  },
];

export const GOOGLE_SERVICE_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  calendar: 'Calendar & Meet',
  sheets: 'Sheets',
  contacts: 'Contacts',
  docs: 'Docs',
  tasks: 'Tasks',
};

export function findGoogleScriptAction(id: string): GoogleScriptAction | undefined {
  return GOOGLE_SCRIPT_ACTIONS.find((a) => a.id === id);
}
