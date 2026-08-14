import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Connector,
  FieldSpec,
  ResourceOption,
} from '../../connections.types';
import { googleRequest } from '../../utils/google-api.util';
import { GOOGLE_PROVIDER, GOOGLE_SCOPES } from './google.oauth';
import { asText, asTextOr } from '../../utils/value.util';

/**
 * Google Calendar.
 *
 * WHY A MEET LINK IS A CHECKBOX HERE AND ALSO ITS OWN APP
 *   Two genuinely different things share the name "Meet link". This one
 *   attaches a conference to a calendar EVENT, so it appears in the
 *   invite, the attendees get it, and it dies with the event. The Meet
 *   connector creates a standalone space with no calendar entry. Neither
 *   substitutes for the other, so both exist.
 *
 * TIMES ARE RFC 3339 AND THE TIMEZONE IS EXPLICIT
 *   An omitted zone is not "the user's" — it is the API server's, which
 *   is a different answer on every deploy. Same reasoning as
 *   WaitUntilStepConfig defaulting to UTC rather than the host clock.
 */

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * Accept both `2026-08-20T14:00:00+05:30` and `2026-08-20 14:00`.
 *
 * The second is what people type, and what a `{{ }}` token from a form
 * field usually contains. Rejecting it would make the field usable only
 * by someone who knows RFC 3339 by sight.
 */
function toRfc3339(value: unknown, label: string): string {
  const raw = asText(value).trim();
  if (!raw) throw new BadRequestException(`"${label}" is required.`);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) {
    return raw.replace(' ', 'T');
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(
      `"${label}" is not a date we can read. Use 2026-08-20T14:00:00 or similar.`,
    );
  }
  return parsed.toISOString();
}

function attendeeList(value: unknown): { email: string }[] | undefined {
  if (!value) return undefined;
  const list = Array.isArray(value) ? value.map(asText) : [asText(value)];
  const emails = list.map((e) => e.trim()).filter(Boolean);
  return emails.length ? emails.map((email) => ({ email })) : undefined;
}

const CALENDAR_FIELD: FieldSpec = {
  key: 'calendar_id',
  label: 'Calendar',
  kind: 'resource_select',
  resource: 'calendars',
  required: true,
  tokens: false,
  default: 'primary',
};

interface GoogleEvent {
  id?: string;
  htmlLink?: string;
  hangoutLink?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  conferenceData?: {
    entryPoints?: { uri?: string; entryPointType?: string }[];
  };
}

function meetLinkOf(event: GoogleEvent): string {
  if (event.hangoutLink) return event.hangoutLink;
  const video = event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === 'video',
  );
  return video?.uri ?? '';
}

export const googleCalendarConnector: Connector = {
  provider: GOOGLE_PROVIDER,
  app: 'google_calendar',
  name: 'Google Calendar',
  blurb: 'Create and manage events, and check availability',
  icon: '/icons/google-calendar.png',
  monogram: 'GC',
  hue: 'oklch(0.62 0.16 255)',

  resources: {
    /**
     * The user's calendars. This one IS listable — `calendar.events`
     * covers calendarList, no Drive scope involved. (Contrast Sheets,
     * where listing files would need a restricted Drive scope.)
     */
    async calendars({ accessToken }): Promise<ResourceOption[]> {
      const res = await googleRequest<{
        items?: { id?: string; summary?: string; primary?: boolean }[];
      }>({
        url: `${CALENDAR_BASE}/users/me/calendarList`,
        accessToken,
        query: { minAccessRole: 'writer', maxResults: 250 },
      });
      return (res.items ?? [])
        .filter((c): c is { id: string; summary?: string; primary?: boolean } =>
          Boolean(c.id),
        )
        .map((c) => ({
          value: c.id,
          label: c.primary
            ? `${c.summary ?? c.id} (primary)`
            : (c.summary ?? c.id),
        }));
    },
  },

  actions: [
    {
      id: 'create_event',
      label: 'Create event',
      description: 'Add an event, optionally with a Meet link',
      scopes: [GOOGLE_SCOPES.calendarEvents],
      outputs: ['event_id', 'html_link', 'meet_link'],
      irreversible: true,
      inputs: [
        CALENDAR_FIELD,
        {
          key: 'summary',
          label: 'Title',
          kind: 'text',
          required: true,
          tokens: true,
          placeholder: 'Call with {{ contact.name }}',
        },
        {
          key: 'description',
          label: 'Description',
          kind: 'long_text',
          required: false,
          tokens: true,
        },
        {
          key: 'start',
          label: 'Starts',
          kind: 'text',
          required: true,
          tokens: true,
          placeholder: '2026-08-20T14:00:00',
        },
        {
          key: 'end',
          label: 'Ends',
          kind: 'text',
          required: true,
          tokens: true,
          placeholder: '2026-08-20T14:30:00',
        },
        {
          key: 'timezone',
          label: 'Timezone',
          kind: 'text',
          required: false,
          tokens: false,
          default: 'UTC',
          placeholder: 'Asia/Kolkata',
          help: 'IANA name. Defaults to UTC — an omitted zone must not mean "the server\'s".',
        },
        {
          key: 'attendees',
          label: 'Attendees',
          kind: 'email_list',
          required: false,
          tokens: true,
          placeholder: '{{ contact.email }}',
        },
        {
          key: 'add_meet',
          label: 'Add a Google Meet link',
          kind: 'boolean',
          required: false,
          default: false,
        },
        {
          key: 'send_updates',
          label: 'Email the attendees',
          kind: 'select',
          required: false,
          default: 'all',
          options: [
            { value: 'all', label: 'Yes, notify everyone' },
            { value: 'externalOnly', label: 'Only people outside my org' },
            { value: 'none', label: 'No notifications' },
          ],
        },
      ],
      async execute({ input, accessToken }) {
        const timezone = asTextOr(input.timezone, 'UTC');
        const addMeet = Boolean(input.add_meet);

        const body: Record<string, unknown> = {
          summary: asText(input.summary),
          description: input.description
            ? asText(input.description)
            : undefined,
          start: {
            dateTime: toRfc3339(input.start, 'Starts'),
            timeZone: timezone,
          },
          end: {
            dateTime: toRfc3339(input.end, 'Ends'),
            timeZone: timezone,
          },
          attendees: attendeeList(input.attendees),
        };

        if (addMeet) {
          // requestId must be unique per creation attempt; Google uses it
          // to make the conference creation idempotent on retry.
          body.conferenceData = {
            createRequest: {
              requestId: randomUUID(),
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          };
        }

        const event = await googleRequest<GoogleEvent>({
          url: `${CALENDAR_BASE}/calendars/${encodeURIComponent(asText(input.calendar_id))}/events`,
          accessToken,
          method: 'POST',
          query: {
            // Without conferenceDataVersion=1 Google silently DROPS the
            // conference request and returns an event with no Meet link
            // — no error, just a missing feature.
            conferenceDataVersion: addMeet ? 1 : 0,
            sendUpdates: asTextOr(input.send_updates, 'all'),
          },
          body,
        });

        return {
          output: {
            event_id: event.id ?? '',
            html_link: event.htmlLink ?? '',
            meet_link: meetLinkOf(event),
          },
          detail: `Created "${asText(input.summary)}"`,
        };
      },
    },

    {
      id: 'update_event',
      label: 'Update event',
      description: 'Change an existing event',
      scopes: [GOOGLE_SCOPES.calendarEvents],
      outputs: ['event_id', 'html_link'],
      inputs: [
        CALENDAR_FIELD,
        {
          key: 'event_id',
          label: 'Event id',
          kind: 'text',
          required: true,
          tokens: true,
          placeholder: '{{ steps.book.event_id }}',
        },
        {
          key: 'summary',
          label: 'Title',
          kind: 'text',
          required: false,
          tokens: true,
        },
        {
          key: 'description',
          label: 'Description',
          kind: 'long_text',
          required: false,
          tokens: true,
        },
        {
          key: 'start',
          label: 'Starts',
          kind: 'text',
          required: false,
          tokens: true,
        },
        {
          key: 'end',
          label: 'Ends',
          kind: 'text',
          required: false,
          tokens: true,
        },
        {
          key: 'timezone',
          label: 'Timezone',
          kind: 'text',
          required: false,
          tokens: false,
          default: 'UTC',
        },
      ],
      async execute({ input, accessToken }) {
        const timezone = asTextOr(input.timezone, 'UTC');
        // PATCH, not PUT: a partial update must leave attendees, the
        // conference and everything else the author did not mention
        // exactly as they are. A PUT with three fields wipes the rest.
        const body: Record<string, unknown> = {};
        if (input.summary) body.summary = asText(input.summary);
        if (input.description) body.description = asText(input.description);
        if (input.start) {
          body.start = {
            dateTime: toRfc3339(input.start, 'Starts'),
            timeZone: timezone,
          };
        }
        if (input.end) {
          body.end = {
            dateTime: toRfc3339(input.end, 'Ends'),
            timeZone: timezone,
          };
        }

        if (Object.keys(body).length === 0) {
          throw new BadRequestException(
            'Nothing to update — fill in at least one field.',
          );
        }

        const event = await googleRequest<GoogleEvent>({
          url: `${CALENDAR_BASE}/calendars/${encodeURIComponent(asText(input.calendar_id))}/events/${encodeURIComponent(asText(input.event_id))}`,
          accessToken,
          method: 'PATCH',
          body,
        });

        return {
          output: { event_id: event.id ?? '', html_link: event.htmlLink ?? '' },
          detail: 'Event updated',
        };
      },
    },

    {
      id: 'delete_event',
      label: 'Delete event',
      description: 'Cancel an event',
      scopes: [GOOGLE_SCOPES.calendarEvents],
      outputs: ['deleted'],
      irreversible: true,
      inputs: [
        CALENDAR_FIELD,
        {
          key: 'event_id',
          label: 'Event id',
          kind: 'text',
          required: true,
          tokens: true,
        },
        {
          key: 'send_updates',
          label: 'Tell the attendees',
          kind: 'select',
          required: false,
          default: 'all',
          options: [
            { value: 'all', label: 'Yes' },
            { value: 'none', label: 'No' },
          ],
        },
      ],
      async execute({ input, accessToken }) {
        await googleRequest({
          url: `${CALENDAR_BASE}/calendars/${encodeURIComponent(asText(input.calendar_id))}/events/${encodeURIComponent(asText(input.event_id))}`,
          accessToken,
          method: 'DELETE',
          query: { sendUpdates: asTextOr(input.send_updates, 'all') },
        });
        return { output: { deleted: true }, detail: 'Event deleted' };
      },
    },

    {
      id: 'find_events',
      label: 'Find events',
      description: 'List events in a time window',
      scopes: [GOOGLE_SCOPES.calendarEvents],
      outputs: ['count', 'events'],
      inputs: [
        CALENDAR_FIELD,
        {
          key: 'from',
          label: 'From',
          kind: 'text',
          required: true,
          tokens: true,
        },
        { key: 'to', label: 'To', kind: 'text', required: true, tokens: true },
        {
          key: 'query',
          label: 'Search text',
          kind: 'text',
          required: false,
          tokens: true,
        },
        {
          key: 'limit',
          label: 'Max results',
          kind: 'number',
          required: false,
          default: 10,
        },
      ],
      async execute({ input, accessToken }) {
        const res = await googleRequest<{ items?: GoogleEvent[] }>({
          url: `${CALENDAR_BASE}/calendars/${encodeURIComponent(asText(input.calendar_id))}/events`,
          accessToken,
          query: {
            timeMin: toRfc3339(input.from, 'From'),
            timeMax: toRfc3339(input.to, 'To'),
            q: input.query ? asText(input.query) : undefined,
            maxResults: Number(input.limit ?? 10),
            singleEvents: true,
            orderBy: 'startTime',
          },
        });

        const events = (res.items ?? []).map((e) => ({
          id: e.id ?? '',
          title: e.summary ?? '',
          start: e.start?.dateTime ?? e.start?.date ?? '',
          end: e.end?.dateTime ?? e.end?.date ?? '',
          link: e.htmlLink ?? '',
          meet_link: meetLinkOf(e),
        }));

        return {
          output: { count: events.length, events },
          detail: `${events.length} event(s)`,
        };
      },
    },

    {
      id: 'check_availability',
      label: 'Check availability',
      description: 'Is this time slot free?',
      // freebusy is its own narrower scope: this action needs to know
      // WHETHER something is booked, not what it is. Asking for
      // calendar.readonly to answer a yes/no question would be asking
      // for the contents of every meeting the user has.
      scopes: [GOOGLE_SCOPES.calendarFreeBusy],
      outputs: ['is_free', 'busy'],
      inputs: [
        CALENDAR_FIELD,
        {
          key: 'from',
          label: 'From',
          kind: 'text',
          required: true,
          tokens: true,
        },
        { key: 'to', label: 'To', kind: 'text', required: true, tokens: true },
      ],
      async execute({ input, accessToken }) {
        const calendarId = asText(input.calendar_id);
        const res = await googleRequest<{
          calendars?: Record<
            string,
            { busy?: { start: string; end: string }[] }
          >;
        }>({
          url: `${CALENDAR_BASE}/freeBusy`,
          accessToken,
          method: 'POST',
          body: {
            timeMin: toRfc3339(input.from, 'From'),
            timeMax: toRfc3339(input.to, 'To'),
            items: [{ id: calendarId }],
          },
        });

        const busy = res.calendars?.[calendarId]?.busy ?? [];
        return {
          output: { is_free: busy.length === 0, busy },
          detail:
            busy.length === 0 ? 'Slot is free' : `${busy.length} clash(es)`,
        };
      },
    },
  ],
};
