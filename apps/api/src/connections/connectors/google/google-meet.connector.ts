import type { Connector } from '../../connections.types';
import { googleRequest } from '../../utils/google-api.util';
import { GOOGLE_PROVIDER, GOOGLE_SCOPES } from './google.oauth';

/**
 * Google Meet — standalone meeting spaces.
 *
 * WHY THIS IS A SEPARATE APP FROM CALENDAR
 *   Google Calendar's `create_event` can attach a Meet conference to an
 *   invite. That link belongs to the event: it appears on the invite,
 *   the attendees get it, and it dies with the event.
 *
 *   This creates a SPACE with no calendar entry at all — a link you can
 *   drop into a WhatsApp reply within seconds of a customer asking to
 *   talk, with nobody's diary involved and no invite to accept. That is
 *   a different product moment, not a variation on the first, and it
 *   uses a different API with its own scope.
 *
 *   Both exist because picking one would break the other's use case.
 *
 * Verified against the Meet REST v2 `spaces.create` reference:
 * POST https://meet.googleapis.com/v2/spaces, scope
 * meetings.space.created, response { name, meetingUri, meetingCode, ... }.
 * `meetingUri` and `meetingCode` are output-only.
 */

const MEET_SPACES_URL = 'https://meet.googleapis.com/v2/spaces';

export const googleMeetConnector: Connector = {
  provider: GOOGLE_PROVIDER,
  app: 'google_meet',
  name: 'Google Meet',
  blurb: 'Create an instant meeting link, no calendar invite',
  icon: '/icons/google-meet.png',
  monogram: 'MT',
  hue: 'oklch(0.66 0.15 145)',

  actions: [
    {
      id: 'create_meet_space',
      label: 'Create meeting link',
      description: 'Make a Meet link you can send straight to a customer',
      scopes: [GOOGLE_SCOPES.meetSpaces],
      outputs: ['meeting_uri', 'meeting_code', 'space_name'],
      // No inputs. A space is created empty and configured by whoever
      // joins; there is nothing meaningful to ask the author for, and
      // inventing a field would just be a box that does nothing.
      inputs: [],
      async execute({ accessToken }) {
        const space = await googleRequest<{
          name?: string;
          meetingUri?: string;
          meetingCode?: string;
        }>({
          url: MEET_SPACES_URL,
          accessToken,
          method: 'POST',
          body: {},
        });

        return {
          output: {
            meeting_uri: space.meetingUri ?? '',
            meeting_code: space.meetingCode ?? '',
            space_name: space.name ?? '',
          },
          detail: space.meetingCode
            ? `Created meeting ${space.meetingCode}`
            : 'Created meeting',
        };
      },
    },
  ],
};
