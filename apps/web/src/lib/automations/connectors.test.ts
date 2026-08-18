/**
 * ⚠️ SEVERAL APPS SHARE ONE OAUTH CONNECTION, AND THAT IS THE TRAP.
 *
 * Sheets, Gmail, Calendar and Meet are four cards on the Integrations
 * page and ONE `app_connections` row, because one Google grant is one
 * token. Anything reporting a state to the user therefore has to ask
 * about SCOPES, not about the provider: connecting Sheets grants
 * `spreadsheets` and nothing else, so a Gmail action on that same
 * connection is refused by the executor before the call.
 *
 * The Integrations page shipped asking `connectionsFor` (provider only),
 * so connecting Sheets alone showed all four apps as "Connected" —
 * confidently wrong, and only discoverable by an automation failing.
 */

import { describe, expect, it } from 'vitest';

import {
  appScopes,
  connectionsFor,
  connectionsGranting,
  missingScopes,
  type AppConnection,
  type CatalogAction,
  type CatalogApp,
} from './connectors';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const CAL_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const CAL_FREEBUSY = 'https://www.googleapis.com/auth/calendar.freebusy';

function action(id: string, scopes: string[]): CatalogAction {
  return { id, label: id, description: '', scopes, inputs: [], outputs: [] };
}

function app(appId: string, actions: CatalogAction[]): CatalogApp {
  return {
    provider: 'google',
    app: appId,
    name: appId,
    blurb: '',
    monogram: 'GG',
    hue: '0',
    actions,
  };
}

const sheets = app('google_sheets', [action('append_row', [SHEETS_SCOPE])]);
const gmail = app('gmail', [action('send_email', [GMAIL_SCOPE])]);
// Calendar's actions do not all need the same scope — the union is what
// the connect flow asks for, so the union is what "connected" means.
const calendar = app('google_calendar', [
  action('create_event', [CAL_EVENTS]),
  action('check_availability', [CAL_FREEBUSY]),
]);

function connection(scopes: string[]): AppConnection {
  return {
    id: 'conn-1',
    provider: 'google',
    displayName: 'someone@example.com',
    scopes: ['openid', 'email', 'profile', ...scopes],
    status: 'active',
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('appScopes', () => {
  it('is the union of every action, mirroring scopesForApp on the server', () => {
    expect(appScopes(calendar).sort()).toEqual(
      [CAL_EVENTS, CAL_FREEBUSY].sort()
    );
  });
});

describe('connectionsGranting', () => {
  const sheetsOnly = [connection([SHEETS_SCOPE])];

  it('does not report a Sheets-only grant as Gmail, Calendar or Meet', () => {
    expect(connectionsGranting(sheetsOnly, sheets)).toHaveLength(1);
    expect(connectionsGranting(sheetsOnly, gmail)).toHaveLength(0);
    expect(connectionsGranting(sheetsOnly, calendar)).toHaveLength(0);
  });

  it('still finds the same row by provider — which is why both exist', () => {
    // `connectionsFor` is correct for a picker offering the account the
    // author obviously meant; it is wrong for a "Connected" badge.
    expect(connectionsFor(sheetsOnly, gmail)).toHaveLength(1);
  });

  it('reports an app whose scopes were granted incrementally', () => {
    // include_granted_scopes unions the grants, so a second connect for
    // Gmail leaves one row covering both apps.
    const both = [connection([SHEETS_SCOPE, GMAIL_SCOPE])];
    expect(connectionsGranting(both, sheets)).toHaveLength(1);
    expect(connectionsGranting(both, gmail)).toHaveLength(1);
  });

  it('refuses a partial grant: one action of an app is not the app', () => {
    const partial = [connection([CAL_EVENTS])];
    expect(connectionsGranting(partial, calendar)).toHaveLength(0);
    // …and the action that IS covered still reports no missing scopes,
    // which is what keeps the step inspector's warning per-action.
    expect(missingScopes(partial[0], calendar.actions[0])).toEqual([]);
    expect(missingScopes(partial[0], calendar.actions[1])).toEqual([
      CAL_FREEBUSY,
    ]);
  });

  it('has nothing to grant for an unknown app', () => {
    expect(
      connectionsGranting([connection([SHEETS_SCOPE])], undefined)
    ).toEqual([]);
  });
});
