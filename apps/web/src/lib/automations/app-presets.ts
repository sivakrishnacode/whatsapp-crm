/**
 * Third-party apps in the step picker.
 *
 * ⚠️ NOT EVERY APP IS A PRESET ANY MORE — READ THIS BEFORE ADDING ONE.
 *   Gmail, Calendar, Meet and Sheets are a real integration: the
 *   workspace's Apps Script bridge (`src/google-script` in the API, the
 *   `google_action` step type, docs/google-apps-script.md). It has a
 *   stored deployment, an encrypted secret and a typed action catalogue.
 *   Do not add a preset for any of them: two Google Sheets entries in one
 *   picker — one wired to the bridge, one asking the author to paste a
 *   URL and a key — is worse than either alone.
 *
 *   The step picker shows connected apps FIRST and these second, under
 *   "Other services", so the difference is visible rather than implied.
 *
 * WHAT THESE ARE, HONESTLY
 *   Each one is an `http_request` step with the service's URL shape,
 *   method, headers and body pre-filled. There is no OAuth, no stored
 *   connection and no per-app action catalogue — you paste your own
 *   webhook URL or API key into the step.
 *
 * WHY PRESETS STILL EXIST ALONGSIDE REAL CONNECTORS
 *   A connector per app is a product in itself: an OAuth flow, token
 *   refresh, scope handling, a typed action list, and — for Google — an
 *   app-verification review. That is worth paying for the handful of
 *   services most customers use every day, and not worth it for the long
 *   tail. Presets get somebody from "I want to post to Slack" to a
 *   working step in one click, work with ANY service on the internet
 *   rather than a fixed list, and cannot silently expire at 3am.
 *
 * WHAT WE MUST NOT DO
 *   Imply a connection exists. Every preset says what it needs in
 *   `credentialHint`, and the picker shows it before the step is added —
 *   otherwise this is a feature that looks like Zapier and then asks for
 *   a bearer token nobody was expecting.
 */

import type { AutomationStepType } from '@/types';

export interface AppPreset {
  id: string;
  name: string;
  /** One line in the picker: what this step does, in the app's terms. */
  blurb: string;
  /** What the author has to supply — shown BEFORE they pick it. */
  credentialHint: string;
  /** Two-letter monogram; these are drawn, not fetched (no external
   *  requests from the editor, and no logo licensing question). */
  monogram: string;
  /** Brand-ish hue for the monogram tile, as oklch. */
  hue: string;
  /** Always `http_request` today — the field exists so a future real
   *  connector can slot in without changing the picker. */
  stepType: AutomationStepType;
  config: Record<string, unknown>;
}

/** Shared shape: a JSON POST whose body is built in the step editor. */
function jsonPost(
  url: string,
  bodyFields: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    method: 'POST',
    url,
    headers: {},
    query: {},
    body_mode: 'json',
    body_fields: bodyFields,
    timeout_seconds: 10,
    ...extra,
  };
}

export const APP_PRESETS: AppPreset[] = [
  {
    id: 'slack',
    name: 'Slack',
    blurb: 'Post a message to a channel',
    credentialHint: 'Needs an incoming-webhook URL from your Slack app',
    monogram: 'SL',
    hue: 'oklch(0.62 0.16 300)',
    stepType: 'http_request',
    config: jsonPost('https://hooks.slack.com/services/REPLACE/ME', {
      text: 'New enquiry from {{ contact.name }} ({{ contact.phone }})',
    }),
  },
  {
    id: 'notion',
    name: 'Notion',
    blurb: 'Create a page in a database',
    credentialHint: 'Needs an internal integration token (Bearer)',
    monogram: 'NO',
    hue: 'oklch(0.55 0.01 260)',
    stepType: 'http_request',
    config: jsonPost(
      'https://api.notion.com/v1/pages',
      {
        parent: { database_id: 'REPLACE_WITH_DATABASE_ID' },
        properties: {
          Name: { title: [{ text: { content: '{{ contact.name }}' } }] },
        },
      },
      {
        headers: { 'Notion-Version': '2022-06-28' },
        auth: { type: 'bearer', token: '' },
      },
    ),
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    blurb: 'Create or update a contact',
    credentialHint: 'Needs a private-app token (Bearer)',
    monogram: 'HS',
    hue: 'oklch(0.65 0.17 40)',
    stepType: 'http_request',
    config: jsonPost(
      'https://api.hubapi.com/crm/v3/objects/contacts',
      {
        properties: {
          firstname: '{{ contact.name }}',
          phone: '{{ contact.phone }}',
          email: '{{ contact.email }}',
        },
      },
      { auth: { type: 'bearer', token: '' } },
    ),
  },
  {
    id: 'mailchimp',
    name: 'Mailchimp',
    blurb: 'Add the contact to an audience',
    credentialHint: 'Needs an API key and your server prefix in the URL',
    monogram: 'MC',
    hue: 'oklch(0.72 0.15 85)',
    stepType: 'http_request',
    config: jsonPost(
      'https://REPLACE.api.mailchimp.com/3.0/lists/LIST_ID/members',
      {
        email_address: '{{ contact.email }}',
        status: 'subscribed',
        merge_fields: { FNAME: '{{ contact.name }}' },
      },
      { auth: { type: 'basic', username: 'anystring', password: '' } },
    ),
  },
  {
    id: 'airtable',
    name: 'Airtable',
    blurb: 'Create a record in a base',
    credentialHint: 'Needs a personal access token (Bearer)',
    monogram: 'AT',
    hue: 'oklch(0.65 0.18 25)',
    stepType: 'http_request',
    config: jsonPost(
      'https://api.airtable.com/v0/BASE_ID/TABLE_NAME',
      {
        fields: {
          Name: '{{ contact.name }}',
          Phone: '{{ contact.phone }}',
        },
      },
      { auth: { type: 'bearer', token: '' } },
    ),
  },
  {
    id: 'discord',
    name: 'Discord',
    blurb: 'Post to a channel',
    credentialHint: 'Needs a channel webhook URL',
    monogram: 'DC',
    hue: 'oklch(0.6 0.16 275)',
    stepType: 'http_request',
    config: jsonPost('https://discord.com/api/webhooks/REPLACE/ME', {
      content: 'New enquiry from {{ contact.name }}',
    }),
  },
  {
    id: 'telegram',
    name: 'Telegram',
    blurb: 'Send a message to a chat',
    credentialHint: 'Needs a bot token in the URL and a chat id',
    monogram: 'TG',
    hue: 'oklch(0.68 0.13 230)',
    stepType: 'http_request',
    config: jsonPost('https://api.telegram.org/botTOKEN/sendMessage', {
      chat_id: 'REPLACE_WITH_CHAT_ID',
      text: 'New enquiry from {{ contact.name }}: {{ message.text }}',
    }),
  },
  {
    id: 'zapier',
    name: 'Zapier / Make',
    blurb: 'Kick off a Zap or scenario',
    credentialHint: 'Needs a catch-hook URL — no key required',
    monogram: 'ZP',
    hue: 'oklch(0.68 0.17 55)',
    stepType: 'http_request',
    config: jsonPost('https://hooks.zapier.com/hooks/catch/REPLACE/ME', {
      contact: '{{ contact.name }}',
      phone: '{{ contact.phone }}',
      message: '{{ message.text }}',
    }),
  },
  {
    id: 'openai',
    name: 'OpenAI',
    blurb: 'Send a prompt and keep the reply',
    credentialHint: 'Needs an API key (Bearer). Billed by OpenAI, not by us.',
    monogram: 'AI',
    hue: 'oklch(0.65 0.1 185)',
    stepType: 'http_request',
    config: jsonPost(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'Summarise this enquiry: {{ message.text }}' },
        ],
      },
      { auth: { type: 'bearer', token: '' }, save_as: 'ai' },
    ),
  },
  {
    id: 'custom',
    name: 'Any other API',
    blurb: 'A blank HTTP request you configure yourself',
    credentialHint: 'Whatever the service needs',
    monogram: 'API',
    hue: 'oklch(0.65 0.1 185)',
    stepType: 'http_request',
    config: jsonPost('', {}),
  },
];

export function findPreset(id: string): AppPreset | undefined {
  return APP_PRESETS.find((p) => p.id === id);
}
