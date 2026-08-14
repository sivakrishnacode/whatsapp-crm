import { BadRequestException } from '@nestjs/common';
import type { Connector } from '../../connections.types';
import { googleRequest } from '../../utils/google-api.util';
import { GOOGLE_PROVIDER, GOOGLE_SCOPES } from './google.oauth';
import { asText } from '../../utils/value.util';

/**
 * Gmail — SEND ONLY.
 *
 * ⚠️⚠️ THERE IS NO DRAFT ACTION, AND ADDING ONE IS NOT A SMALL CHANGE.
 *
 *   Saving a draft instead of sending looks like the cautious option, so
 *   somebody will propose it. Google classifies it the other way round:
 *
 *     gmail.send      SENSITIVE   — can only push a message out
 *     gmail.compose   RESTRICTED  — can read, update and delete drafts
 *
 *   A restricted scope requires an annual third-party CASA security
 *   assessment: paid, recurring, and it audits the application. A
 *   sensitive scope requires a one-off verification review. `gmail.send`
 *   is the ONLY Gmail scope on the cheap side of that line, precisely
 *   because it can read nothing at all.
 *
 *   The same rule kills every "just let it search for the thread" idea:
 *   searching is `gmail.readonly`, which is restricted.
 *
 * WHY `From` IS NOT A FIELD
 *   It is always the connected account. A free-text From on an
 *   automation that any workspace member can edit is a phishing feature,
 *   and Gmail would refuse most of the values anyway.
 */

const GMAIL_SEND_URL =
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/**
 * Build an RFC 2822 message.
 *
 * Headers are sanitised for CR/LF before they go anywhere near the
 * buffer: every one of these values can come from `{{ }}` interpolation,
 * and a newline inside a subject is header injection — it lets an
 * automation author (or, through a token, a customer's own message text)
 * append `Bcc:` and silently copy a third party on everything.
 */
export function buildMimeMessage(args: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html: boolean;
  replyTo?: string;
  /** Set on a reply so Gmail threads it correctly. */
  inReplyTo?: string;
}): string {
  const headerSafe = (value: string): string =>
    value.replace(/[\r\n]+/g, ' ').trim();

  const lines: string[] = [
    `To: ${args.to.map(headerSafe).join(', ')}`,
    `Subject: ${encodeHeaderWord(headerSafe(args.subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: ${args.html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
  ];
  if (args.cc?.length) lines.push(`Cc: ${args.cc.map(headerSafe).join(', ')}`);
  if (args.bcc?.length)
    lines.push(`Bcc: ${args.bcc.map(headerSafe).join(', ')}`);
  if (args.replyTo) lines.push(`Reply-To: ${headerSafe(args.replyTo)}`);
  if (args.inReplyTo) {
    const id = headerSafe(args.inReplyTo);
    lines.push(`In-Reply-To: ${id}`, `References: ${id}`);
  }

  // The body is base64'd rather than inlined: a raw body containing a
  // line that happens to be "." or a very long line breaks SMTP framing,
  // and non-ASCII needs an encoding declared anyway.
  const body = Buffer.from(args.body, 'utf8').toString('base64');
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * RFC 2047 encode a header when it is not plain ASCII.
 *
 * Without this, a subject containing an emoji or an accented name
 * arrives as mojibake — which is most of the point of putting a
 * customer's name in a subject line.
 */
function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately testing for non-ASCII
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

const RECIPIENT_FIELDS = [
  {
    key: 'to',
    label: 'To',
    kind: 'email_list' as const,
    required: true,
    tokens: true,
    placeholder: '{{ contact.email }}',
  },
  {
    key: 'cc',
    label: 'Cc',
    kind: 'email_list' as const,
    required: false,
    tokens: true,
  },
  {
    key: 'bcc',
    label: 'Bcc',
    kind: 'email_list' as const,
    required: false,
    tokens: true,
  },
];

export const gmailConnector: Connector = {
  provider: GOOGLE_PROVIDER,
  app: 'gmail',
  name: 'Gmail',
  blurb: 'Send email from your connected Google account',
  icon: '/icons/gmail.png',
  monogram: 'GM',
  hue: 'oklch(0.62 0.19 25)',

  actions: [
    {
      id: 'send_email',
      label: 'Send email',
      description: 'Send a new email as the connected account',
      scopes: [GOOGLE_SCOPES.gmailSend],
      outputs: ['message_id', 'thread_id'],
      // Google has no dry-run for a send. The editor's Test tab asks
      // twice because of this flag — a "test" here reaches a real inbox.
      irreversible: true,
      inputs: [
        ...RECIPIENT_FIELDS,
        {
          key: 'subject',
          label: 'Subject',
          kind: 'text',
          required: true,
          tokens: true,
        },
        {
          key: 'body',
          label: 'Message',
          kind: 'long_text',
          required: true,
          tokens: true,
        },
        {
          key: 'html',
          label: 'Send as HTML',
          kind: 'boolean',
          required: false,
          default: false,
          help: 'Off sends plain text. On lets you use HTML tags in the message.',
        },
        {
          key: 'reply_to',
          label: 'Reply-To',
          kind: 'text',
          required: false,
          tokens: true,
          help: 'Where replies should go. Defaults to the connected account.',
        },
      ],
      async execute({ input, accessToken }) {
        const raw = buildMimeMessage({
          to: input.to as string[],
          cc: input.cc as string[] | undefined,
          bcc: input.bcc as string[] | undefined,
          subject: asText(input.subject),
          body: asText(input.body),
          html: Boolean(input.html),
          replyTo: input.reply_to ? asText(input.reply_to) : undefined,
        });

        const res = await googleRequest<{ id?: string; threadId?: string }>({
          url: GMAIL_SEND_URL,
          accessToken,
          method: 'POST',
          body: { raw: Buffer.from(raw, 'utf8').toString('base64url') },
        });

        return {
          output: { message_id: res.id ?? '', thread_id: res.threadId ?? '' },
          detail: `Sent to ${(input.to as string[]).join(', ')}`,
        };
      },
    },

    {
      id: 'send_reply',
      label: 'Send reply',
      description: 'Reply on a thread an earlier step created',
      scopes: [GOOGLE_SCOPES.gmailSend],
      outputs: ['message_id', 'thread_id'],
      irreversible: true,
      inputs: [
        {
          key: 'thread_id',
          label: 'Thread',
          kind: 'text',
          required: true,
          tokens: true,
          placeholder: '{{ steps.notify.thread_id }}',
          // This help text is load-bearing. Without it the first thing
          // anyone asks for is a thread picker, which cannot be built:
          // searching a mailbox needs gmail.readonly, which is
          // restricted, which means CASA.
          help: 'Must come from an earlier Send email step in this automation. This app cannot search your mailbox for a thread.',
        },
        ...RECIPIENT_FIELDS,
        {
          key: 'subject',
          label: 'Subject',
          kind: 'text',
          required: true,
          tokens: true,
          placeholder: 'Re: your enquiry',
        },
        {
          key: 'body',
          label: 'Message',
          kind: 'long_text',
          required: true,
          tokens: true,
        },
        {
          key: 'html',
          label: 'Send as HTML',
          kind: 'boolean',
          required: false,
          default: false,
        },
      ],
      async execute({ input, accessToken }) {
        const threadId = asText(input.thread_id).trim();
        if (!threadId) {
          throw new BadRequestException(
            'No thread id. Point this at the thread_id output of an earlier Send email step.',
          );
        }

        const raw = buildMimeMessage({
          to: input.to as string[],
          cc: input.cc as string[] | undefined,
          bcc: input.bcc as string[] | undefined,
          subject: asText(input.subject),
          body: asText(input.body),
          html: Boolean(input.html),
        });

        const res = await googleRequest<{ id?: string; threadId?: string }>({
          url: GMAIL_SEND_URL,
          accessToken,
          method: 'POST',
          body: {
            raw: Buffer.from(raw, 'utf8').toString('base64url'),
            threadId,
          },
        });

        return {
          output: { message_id: res.id ?? '', thread_id: res.threadId ?? '' },
          detail: `Replied on thread ${threadId}`,
        };
      },
    },
  ],
};
