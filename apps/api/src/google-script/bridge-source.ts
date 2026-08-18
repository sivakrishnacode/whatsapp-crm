/**
 * The Apps Script source we hand the customer, with their secret already
 * in it.
 *
 * ⚠️ THIS FILE IS THE AUTHORITY FOR WHAT CUSTOMERS RUN.
 *   `docs/apps-script/converse360-bridge.gs` is a readable copy for
 *   anyone setting the bridge up by hand; the product serves THIS one, so
 *   a fix belongs here first.
 *
 * ⚠️ IT CONTAINS NO CONVERSE360 CREDENTIAL, AND THAT IS A PROPERTY WORTH
 *    KEEPING.
 *   An earlier draft had the script call our API back, because a POST to
 *   /exec answers with a 302 and we could not read the reply. Following
 *   that redirect as a GET in the executor removed the need entirely: the
 *   result now travels home in the response body, so the script holds one
 *   secret (ours, for authenticating inbound calls) and nothing that could
 *   act on the workspace.
 *
 * ⚠️ NOTHING HERE READS A MAILBOX OR TOUCHES DRIVE.
 *   `gmail.send` is send-only; `gmail.compose`, `gmail.readonly` and every
 *   Drive scope are Google-RESTRICTED, which is a different and much more
 *   expensive category. That constraint outlived the OAuth connector it
 *   was written for: a customer's own script asking for restricted access
 *   is still asking for restricted access.
 */

import { BRIDGE_VERSION } from './google-script.catalog';

/** Replaced with the workspace's real secret when the script is served. */
export const SECRET_PLACEHOLDER = '__CONVERSE360_SECRET__';

const SOURCE = String.raw`/**
 * Converse360 ↔ Google bridge
 * Generated for your workspace. Do not share this file: the secret below
 * lets Converse360 act on this Google account.
 *
 * Setup, in order:
 *   1. Services → + → Calendar API  (required; calendar calls fail without it)
 *   2. Project Settings → show appsscript.json → paste the oauthScopes block
 *      Converse360 showed you
 *   3. Run authorizeOnce, approve the prompt
 *   4. Deploy → New deployment → Web app
 *        Execute as:      Me
 *        Who has access:  Anyone      ← anything else returns a login page
 *   5. Copy the /exec URL back into Converse360
 */

const SECRET = '__CONVERSE360_SECRET__';
const BRIDGE_VERSION = __BRIDGE_VERSION__;

/** Calendar to act on. 'primary' is this account's own. */
const CALENDAR_ID = 'primary';

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply_({ ok: false, error: 'body is not valid JSON' });
  }

  // Vague on purpose: a caller without the secret learns nothing about
  // whether the action name was even valid.
  if (!secretOk_(payload.secret)) return reply_({ ok: false, error: 'unauthorized' });

  try {
    return reply_(dispatch_(payload));
  } catch (err) {
    Logger.log('action ' + payload.action + ' failed: ' + err);
    return reply_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function dispatch_(p) {
  switch (p.action) {
    case 'send_email':         return sendEmail_(p);
    case 'create_event':       return createEvent_(p);
    case 'check_availability': return checkAvailability_(p);
    case 'sheet_append':       return sheetAppend_(p);
    case 'sheet_find':         return sheetFind_(p);
    case 'sheet_update':       return sheetUpdate_(p);
    default:                   return { ok: false, error: 'unknown action: ' + p.action };
  }
}

/* -------------------------------------------------------------- Gmail */

function sendEmail_(p) {
  require_(p, ['to', 'subject', 'body']);
  var options = { name: p.from_name || undefined };
  if (p.html) options.htmlBody = p.body;
  if (p.cc) options.cc = list_(p.cc).join(',');
  if (p.bcc) options.bcc = list_(p.bcc).join(',');
  if (p.reply_to) options.replyTo = p.reply_to;

  GmailApp.sendEmail(list_(p.to).join(','), p.subject, p.body, options);
  return { ok: true, version: BRIDGE_VERSION, to: list_(p.to).join(', ') };
}

/* ----------------------------------------------------------- Calendar */

/**
 * Uses the ADVANCED Calendar service, not CalendarApp: conferenceData is
 * the only way to attach a real Meet link and CalendarApp cannot set it.
 * That is also why a standalone Meet action does not exist — it would need
 * the Meet API enabled on this project's GCP project, which an Apps Script
 * default project does not allow.
 */
function createEvent_(p) {
  require_(p, ['title', 'starts_at', 'ends_at']);
  var tz = p.timezone || Session.getScriptTimeZone();

  var resource = {
    summary: p.title,
    description: p.description || '',
    start: { dateTime: p.starts_at, timeZone: tz },
    end: { dateTime: p.ends_at, timeZone: tz }
  };
  if (p.attendees) {
    resource.attendees = list_(p.attendees).map(function (email) { return { email: email }; });
  }

  var options = {};
  if (p.add_meet) {
    resource.conferenceData = {
      createRequest: {
        // Unique per request, or Google reuses the previous conference.
        requestId: Utilities.getUuid(),
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    };
    options.conferenceDataVersion = 1; // omit this and the link is dropped silently
  }
  if (p.notify) options.sendUpdates = p.notify;

  var event = Calendar.Events.insert(resource, CALENDAR_ID, options);
  return {
    ok: true,
    version: BRIDGE_VERSION,
    event_id: event.id,
    html_link: event.htmlLink,
    meeting_url: event.hangoutLink || null
  };
}

/** Busy blocks only — never event titles. */
function checkAvailability_(p) {
  require_(p, ['from', 'to']);
  var res = Calendar.Freebusy.query({
    timeMin: p.from,
    timeMax: p.to,
    items: [{ id: CALENDAR_ID }]
  });
  var cal = res.calendars[CALENDAR_ID] || {};
  return {
    ok: true,
    version: BRIDGE_VERSION,
    busy: (cal.busy || []).map(function (b) { return { start: b.start, end: b.end }; })
  };
}

/* ------------------------------------------------------------- Sheets */

function sheetAppend_(p) {
  require_(p, ['spreadsheet_id', 'values']);
  var sheet = tab_(p);
  sheet.appendRow(list_(p.values));
  return { ok: true, version: BRIDGE_VERSION, row: sheet.getLastRow() };
}

function sheetFind_(p) {
  require_(p, ['spreadsheet_id', 'column', 'value']);
  var found = findRow_(tab_(p), p.column, p.value);
  if (!found) return { ok: true, version: BRIDGE_VERSION, found: false };
  return { ok: true, version: BRIDGE_VERSION, found: true, row: found.row, values: found.values };
}

function sheetUpdate_(p) {
  require_(p, ['spreadsheet_id', 'column', 'value', 'values']);
  var sheet = tab_(p);
  var found = findRow_(sheet, p.column, p.value);
  if (!found) return { ok: true, version: BRIDGE_VERSION, found: false };

  var values = list_(p.values);
  sheet.getRange(found.row, 1, 1, values.length).setValues([values]);
  return { ok: true, version: BRIDGE_VERSION, found: true, row: found.row };
}

function tab_(p) {
  var book = SpreadsheetApp.openById(p.spreadsheet_id);
  var sheet = p.tab ? book.getSheetByName(p.tab) : book.getSheets()[0];
  if (!sheet) throw new Error('no tab named "' + p.tab + '"');
  return sheet;
}

/** First data row whose header-named column equals value. Row 1 = headers. */
function findRow_(sheet, column, value) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return null;

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var index = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === String(column).trim().toLowerCase()) {
      index = i;
      break;
    }
  }
  if (index === -1) throw new Error('no column named "' + column + '"');

  var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var needle = String(value).trim();
  for (var r = 0; r < rows.length; r++) {
    if (String(rows[r][index]).trim() === needle) return { row: r + 2, values: rows[r] };
  }
  return null;
}

/* ----------------------------------------------------------- Plumbing */

/**
 * Compare digests, not the secrets themselves. Apps Script has no
 * timing-safe compare and === on strings exits at the first differing
 * character; hashing first makes the comparison run over fixed-length
 * bytes an attacker cannot steer.
 */
function secretOk_(supplied) {
  if (typeof supplied !== 'string' || !supplied.length) return false;
  var a = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, supplied);
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SECRET);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function require_(p, fields) {
  var missing = fields.filter(function (f) {
    return p[f] === undefined || p[f] === null || p[f] === '';
  });
  if (missing.length) throw new Error('missing required field(s): ' + missing.join(', '));
}

/** Accept a single value or an array; always return an array. */
function list_(value) {
  if (Object.prototype.toString.call(value) === '[object Array]') return value;
  return String(value)
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ''; });
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this once before deploying, so the authorization prompt appears
 * while you are watching rather than on the first real automation call.
 * One prompt covers every scope in the manifest.
 */
function authorizeOnce() {
  Calendar.Events.list(CALENDAR_ID, { maxResults: 1 });
  Logger.log('Authorized. Next: Deploy → New deployment → Web app.');
}
`;

/**
 * The manifest the customer pastes into `appsscript.json`.
 *
 * ⚠️ Scopes are declared EXPLICITLY because Apps Script otherwise infers
 * them from the code and over-asks. `calendar.events` + `calendar.freebusy`
 * rather than the broad `calendar` — both verified working against a live
 * deployment. No `meetings.space.created` (no standalone Meet action), no
 * Drive, no Gmail scope beyond send.
 *
 * `webapp` pre-sets the deploy dialog so "Anyone with Google account"
 * cannot be chosen by accident; that setting returns a login page to us
 * instead of running.
 */
export const BRIDGE_MANIFEST = JSON.stringify(
  {
    timeZone: 'Asia/Kolkata',
    dependencies: {
      enabledAdvancedServices: [{ userSymbol: 'Calendar', version: 'v3', serviceId: 'calendar' }],
    },
    exceptionLogging: 'STACKDRIVER',
    runtimeVersion: 'V8',
    oauthScopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/script.external_request',
    ],
    webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' },
  },
  null,
  2,
);

/**
 * The script with the workspace's secret in it.
 *
 * Takes the plaintext secret, so it is only ever called on the request
 * that mints one — the value is not stored anywhere it could be fetched
 * again, and the endpoint that returns this is the one place it appears.
 */
export function renderBridgeSource(secret: string): string {
  return SOURCE.split(SECRET_PLACEHOLDER)
    .join(secret)
    .split('__BRIDGE_VERSION__')
    .join(String(BRIDGE_VERSION));
}
