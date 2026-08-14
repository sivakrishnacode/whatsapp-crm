/**
 * Google OAuth endpoints, scopes and the identity lookup.
 *
 * Shared by all four Google connectors: they are four apps on ONE
 * connection, because Google issues one refresh token per (client, user)
 * regardless of how many product scopes it covers. Modelling them as
 * four connections would mean four rows sharing a token and four places
 * to invalidate on revoke.
 *
 * ⚠️⚠️ EVERY SCOPE HERE IS "SENSITIVE". NOT ONE IS "RESTRICTED", AND
 *      THAT IS THE PROJECT'S CENTRAL CONSTRAINT.
 *
 *   Google splits third-party scopes three ways: non-sensitive,
 *   sensitive, and restricted. Sensitive needs an app-verification
 *   review — a one-off cost. RESTRICTED needs that review PLUS an annual
 *   third-party CASA security assessment, which is paid, recurring, and
 *   audits the application itself.
 *
 *   So the catalogue is shaped by which side of that line each capability
 *   falls on:
 *
 *     gmail.send        SENSITIVE   — send only, reads nothing
 *     gmail.compose     RESTRICTED  — can read/update/delete drafts
 *     gmail.readonly    RESTRICTED
 *     drive/.readonly   RESTRICTED
 *
 *   Which produces two counter-intuitive rules that must not be
 *   "simplified" later:
 *
 *   1. THERE IS NO create_draft ACTION, AND THERE MUST NEVER BE ONE.
 *      Saving a draft feels gentler than sending, so it looks like the
 *      safe default. It is the opposite: `gmail.compose` can read
 *      drafts, so Google classes it restricted. Send-only is what keeps
 *      this connector free to operate.
 *
 *   2. NOTHING LISTS A USER'S FILES. Picking a spreadsheet from a list
 *      needs Drive. Spreadsheet ids are pasted from the sheet's URL, and
 *      the TABS inside are then listed through the Sheets API — which is
 *      the dropdown people actually wanted anyway.
 *
 *   Adding one restricted scope converts this from a one-off review into
 *   a recurring paid assessment. That is a business decision, not a
 *   ticket. See docs/app-connections.md.
 */

export const GOOGLE_PROVIDER = 'google';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL =
  'https://openidconnect.googleapis.com/v1/userinfo';

/** Identity scopes, always requested — they name the connection in the UI. */
export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'];

export const GOOGLE_SCOPES = {
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  calendarFreeBusy: 'https://www.googleapis.com/auth/calendar.freebusy',
  meetSpaces: 'https://www.googleapis.com/auth/meetings.space.created',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
} as const;

/**
 * Scopes we will ever ask for. The OAuth start endpoint refuses anything
 * outside this set, so a crafted `?scopes=` cannot widen a grant beyond
 * what the consent screen was verified for — and cannot smuggle in a
 * restricted scope.
 */
export const GOOGLE_ALLOWED_SCOPES = new Set<string>([
  ...GOOGLE_IDENTITY_SCOPES,
  ...Object.values(GOOGLE_SCOPES),
]);

export interface GoogleIdentity {
  sub: string;
  email?: string;
  name?: string;
}

export function googleOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, ' +
        'GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI.',
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** Whose account this is. Used only to label the connection. */
export async function fetchGoogleIdentity(
  accessToken: string,
): Promise<GoogleIdentity> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: 'manual',
  });
  if (!res.ok) {
    throw new Error(`Google userinfo failed with ${res.status}`);
  }
  const body = (await res.json()) as GoogleIdentity;
  if (!body.sub) throw new Error('Google userinfo returned no subject id');
  return body;
}
