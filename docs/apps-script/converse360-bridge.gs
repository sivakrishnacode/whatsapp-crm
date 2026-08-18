/**
 * Converse360 → Google bridge (Gmail, Calendar, Meet, Sheets).
 *
 * A web app the CUSTOMER deploys in their own Google account. Converse360
 * calls it with an `http_request` automation step; it performs the Google
 * work as the customer and needs no OAuth grant from us, so it works
 * while our own verification is still in review.
 *
 * ⚠️⚠️ THE DEPLOYMENT URL IS A CREDENTIAL FOR THIS GOOGLE ACCOUNT.
 *   A web app deployed "Execute as: Me" + "Who has access: Anyone" runs
 *   under the deploying user's authority for whoever holds the URL. That
 *   is why `SECRET` below exists and why it must be long and random.
 *   Anyone with URL + secret can send mail as this account. Treat the
 *   pair like a password: never in a shared doc, never in a screenshot,
 *   rotate by redeploying with a new secret.
 *
 * ⚠️ THE SECRET TRAVELS IN THE BODY, NOT A HEADER.
 *   Apps Script web apps cannot read custom request headers — `doPost`
 *   sees `e.postData` and `e.parameter` only. A header-based scheme fails
 *   open here, which is the worst possible way to fail, so the check is
 *   on a body field.
 *
 * ⚠️ CONVERSE360 CANNOT READ THIS SCRIPT'S REPLY.
 *   Google answers a POST to /exec with a 302 to googleusercontent.com,
 *   and the `http_request` step uses `redirect: 'manual'` and does not
 *   follow (a public URL that 3xx-bounces to an internal address is
 *   exactly what that guard is for). So the step sees 302 and never the
 *   body. A 302 means the script RAN — Google executes doPost before
 *   redirecting. Anything you need back must be pushed via `callback`,
 *   not returned. See docs/google-apps-script.md.
 *
 * Setup, manifest scopes and the automation step config: see
 * docs/google-apps-script.md.
 */

const SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING';

/** Converse360 API, used only by the `callback` path. */
const CONVERSE360 = {
  API_BASE: 'https://app.converse360.in/api/v1',
  // Needs only the scopes your callbacks use — messages:send for a chat
  // reply, contacts:write to stamp a field. Not an admin key.
  API_KEY: 'converse360_live_REPLACE_ME',
};

/** Calendar to act on. 'primary' is the deploying user's own. */
const CALENDAR_ID = 'primary';

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply_({ ok: false, error: 'body is not valid JSON' });
  }

  if (!secretOk_(payload.secret)) {
    // Deliberately vague: a caller without the secret learns nothing
    // about whether the action name was valid.
    return reply_({ ok: false, error: 'unauthorized' });
  }

  let result;
  try {
    result = dispatch_(payload);
  } catch (err) {
    // Errors come back in the body, which only a redirect-following
    // client sees. Logger.log is what YOU read in Executions.
    Logger.log('action ' + payload.action + ' failed: ' + err);
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }

  if (payload.callback) {
    try {
      sendCallback_(payload.callback, result);
    } catch (err) {
      Logger.log('callback failed: ' + err);
    }
  }

  return reply_(result);
}

function dispatch_(p) {
  switch (p.action) {
    case 'send_email':
      return sendEmail_(p);
    case 'create_event':
      return createEvent_(p);
    case 'create_meet':
      return createMeet_(p);
    case 'check_availability':
      return checkAvailability_(p);
    case 'sheet_append':
      return sheetAppend_(p);
    case 'sheet_find':
      return sheetFind_(p);
    case 'sheet_update':
      return sheetUpdate_(p);
    default:
      return { ok: false, error: 'unknown action: ' + p.action };
  }
}

/* ------------------------------------------------------------------ Gmail */

/**
 * Send as the deploying user. Scope: gmail.send.
 *
 * Send-only on purpose — nothing here reads a mailbox, matching the
 * OAuth connector's constraint. Do not add a draft or read action: the
 * scopes for those are Google-RESTRICTED and drag in a paid annual CASA
 * assessment even when it is the customer's own script.
 */
function sendEmail_(p) {
  requireFields_(p, ['to', 'subject', 'body']);
  const options = { name: p.from_name || undefined };
  if (p.html) options.htmlBody = p.body;
  if (p.cc) options.cc = asList_(p.cc).join(',');
  if (p.bcc) options.bcc = asList_(p.bcc).join(',');
  if (p.reply_to) options.replyTo = p.reply_to;

  GmailApp.sendEmail(asList_(p.to).join(','), p.subject, p.body, options);
  return { ok: true, action: 'send_email', to: asList_(p.to) };
}

/* --------------------------------------------------------------- Calendar */

/**
 * Create an event, optionally with a Meet link.
 *
 * Uses the ADVANCED Calendar service, not CalendarApp: `conferenceData`
 * is the only way to attach a real Meet link, and CalendarApp cannot
 * set it. Enable Services → Calendar API in the editor or every call
 * here throws "Calendar is not defined".
 */
function createEvent_(p) {
  requireFields_(p, ['title', 'starts_at', 'ends_at']);

  const resource = {
    summary: p.title,
    description: p.description || '',
    start: { dateTime: p.starts_at, timeZone: p.timezone || Session.getScriptTimeZone() },
    end: { dateTime: p.ends_at, timeZone: p.timezone || Session.getScriptTimeZone() },
  };

  if (p.attendees) {
    resource.attendees = asList_(p.attendees).map(function (email) {
      return { email: email };
    });
  }

  const options = {};
  if (p.add_meet) {
    resource.conferenceData = {
      createRequest: {
        // Must be unique per request or Google reuses the previous
        // conference. Utilities.getUuid() is the cheapest guarantee.
        requestId: Utilities.getUuid(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
    options.conferenceDataVersion = 1; // omitting this silently drops the link
  }
  if (p.notify) options.sendUpdates = p.notify; // 'all' | 'externalOnly' | 'none'

  const event = Calendar.Events.insert(resource, CALENDAR_ID, options);
  return {
    ok: true,
    action: 'create_event',
    event_id: event.id,
    html_link: event.htmlLink,
    meeting_url: event.hangoutLink || null,
  };
}

/**
 * Standalone Meet link, no calendar entry.
 *
 * ⚠️ OPTIONAL, AND OFF BY DEFAULT. Verified against a live deployment:
 * this returns
 *
 *   Meet API 403: Google Meet API has not been used in project <n>
 *   before or it is disabled
 *
 * because an Apps Script project's DEFAULT GCP project does not let you
 * enable extra APIs — you have to attach a standard GCP project first.
 * That is fine for one internal install and unacceptable as a step in a
 * customer's setup, so the default manifest omits
 * `meetings.space.created` and this action stays unused.
 *
 * ⚠️ USE `create_event` WITH `add_meet: true` INSTEAD. It returns a real
 * `meeting_url` through the Calendar API, which the advanced service
 * already covers — no Meet API, no GCP work, one less scope on the
 * consent screen. Verified: returns https://meet.google.com/xxx-xxxx-xxx.
 *
 * To enable this anyway: Project Settings → attach a standard GCP
 * project → enable the Google Meet API there → add
 * `https://www.googleapis.com/auth/meetings.space.created` to
 * `oauthScopes` → re-authorize → redeploy a new version.
 */
function createMeet_(p) {
  const res = UrlFetchApp.fetch('https://meet.googleapis.com/v2/spaces', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({}),
    muteHttpExceptions: true,
  });

  const status = res.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error('Meet API ' + status + ': ' + res.getContentText().slice(0, 200));
  }
  const space = JSON.parse(res.getContentText());
  return {
    ok: true,
    action: 'create_meet',
    meeting_url: space.meetingUri,
    meeting_code: space.meetingCode || null,
  };
}

/**
 * Busy intervals between two instants. Scope: calendar.readonly (or
 * calendar). Returns busy blocks only — never event titles.
 */
function checkAvailability_(p) {
  requireFields_(p, ['from', 'to']);
  const result = Calendar.Freebusy.query({
    timeMin: p.from,
    timeMax: p.to,
    items: [{ id: CALENDAR_ID }],
  });
  const cal = result.calendars[CALENDAR_ID] || {};
  return {
    ok: true,
    action: 'check_availability',
    busy: (cal.busy || []).map(function (b) {
      return { start: b.start, end: b.end };
    }),
  };
}

/* ----------------------------------------------------------------- Sheets */

function sheetAppend_(p) {
  requireFields_(p, ['spreadsheet_id', 'values']);
  const sheet = openTab_(p);
  sheet.appendRow(asList_(p.values));
  return { ok: true, action: 'sheet_append', row: sheet.getLastRow() };
}

function sheetFind_(p) {
  requireFields_(p, ['spreadsheet_id', 'column', 'value']);
  const sheet = openTab_(p);
  const found = findRow_(sheet, p.column, p.value);
  if (!found) return { ok: true, action: 'sheet_find', found: false };
  return {
    ok: true,
    action: 'sheet_find',
    found: true,
    row: found.row,
    values: found.values,
  };
}

function sheetUpdate_(p) {
  requireFields_(p, ['spreadsheet_id', 'column', 'value', 'values']);
  const sheet = openTab_(p);
  const found = findRow_(sheet, p.column, p.value);
  if (!found) return { ok: true, action: 'sheet_update', found: false };

  const values = asList_(p.values);
  sheet.getRange(found.row, 1, 1, values.length).setValues([values]);
  return { ok: true, action: 'sheet_update', found: true, row: found.row };
}

/**
 * `openById`, so this script needs the full `spreadsheets` scope — it
 * cannot use @OnlyCurrentDoc, unlike the inbound sync script. That is
 * the honest cost of a bridge that writes to a sheet named at call time.
 */
function openTab_(p) {
  const book = SpreadsheetApp.openById(p.spreadsheet_id);
  const sheet = p.tab ? book.getSheetByName(p.tab) : book.getSheets()[0];
  if (!sheet) throw new Error('no tab named "' + p.tab + '"');
  return sheet;
}

/** First data row whose `column` header cell equals `value`. 1-indexed. */
function findRow_(sheet, column, value) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return null;

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let index = -1;
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === String(column).trim().toLowerCase()) {
      index = i;
      break;
    }
  }
  if (index === -1) throw new Error('no column named "' + column + '"');

  const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const needle = String(value).trim();
  for (let r = 0; r < rows.length; r++) {
    if (String(rows[r][index]).trim() === needle) {
      return { row: r + 2, values: rows[r] };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ Plumbing */

/**
 * Compare digests, not the secrets themselves.
 *
 * Apps Script has no timing-safe compare, and `a === b` on strings exits
 * at the first differing character. Hashing both sides first makes the
 * comparison run over fixed-length, attacker-unpredictable bytes, so the
 * timing carries nothing useful about the real secret.
 */
function secretOk_(supplied) {
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  if (SECRET === 'REPLACE_WITH_A_LONG_RANDOM_STRING') {
    throw new Error('SECRET is still the placeholder. Set it before deploying.');
  }
  const a = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, supplied);
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SECRET);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Push a result back to Converse360, since it cannot read our response.
 *
 * `callback.type`:
 *   'message' — send `template` as a WhatsApp/Instagram message to
 *               `callback.to`. `{{meeting_url}}` etc. are substituted
 *               from the result, which is how a Meet link reaches a
 *               customer's chat.
 *   'webhook' — POST the raw result to `callback.url`. Use for your own
 *               endpoint; the API key is not sent.
 */
function sendCallback_(callback, result) {
  if (callback.type === 'webhook' && callback.url) {
    UrlFetchApp.fetch(callback.url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(result),
      muteHttpExceptions: true,
    });
    return;
  }

  if (callback.type === 'message' && callback.to && callback.template) {
    const text = String(callback.template).replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, key) {
      return result[key] === undefined || result[key] === null ? '' : String(result[key]);
    });
    UrlFetchApp.fetch(CONVERSE360.API_BASE + '/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + CONVERSE360.API_KEY },
      payload: JSON.stringify({ to: callback.to, type: 'text', text: text }),
      muteHttpExceptions: true,
    });
  }
}

function requireFields_(p, fields) {
  const missing = fields.filter(function (f) {
    return p[f] === undefined || p[f] === null || p[f] === '';
  });
  if (missing.length) throw new Error('missing required field(s): ' + missing.join(', '));
}

/** Accept either a single value or an array, always return an array. */
function asList_(value) {
  if (Object.prototype.toString.call(value) === '[object Array]') return value;
  return String(value)
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s !== '';
    });
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

/**
 * Run this ONCE from the editor before deploying.
 *
 * It triggers the authorization prompt at a moment you are watching,
 * rather than on the first real automation call — where the failure
 * would look like a Converse360 bug.
 *
 * One prompt covers EVERY scope in `oauthScopes`, so this does not need
 * to touch each service. It deliberately does not call Gmail: the
 * read-ish helpers (`getRemainingDailyQuota` and friends) can demand a
 * broader Gmail scope than the send-only one we declare, and a throw
 * here would be alarming in the one function whose job is reassurance.
 */
function authorizeOnce() {
  Calendar.Events.list(CALENDAR_ID, { maxResults: 1 });
  ScriptApp.getOAuthToken();
  Logger.log('Authorized. Next: Deploy → New deployment → Web app.');
}

/* =============================================================== SELF-TEST */

/** Settings for runSelfTest. */
const TEST = {
  /**
   * REQUIRED for the Gmail check — put your own address here.
   *
   * ⚠️ Do NOT reach for `Session.getActiveUser().getEmail()` to fill this
   * in automatically. It needs `userinfo.email`, which is deliberately
   * absent from `oauthScopes`, so it throws "Specified permissions are
   * not sufficient" and the Gmail check fails for a reason that has
   * nothing to do with Gmail. Adding a scope to serve a test helper is
   * the wrong trade: one hard-coded address here costs nothing.
   */
  EMAIL: '',
  /**
   * Blank = skip the three Sheets checks. Paste the id from a sheet URL:
   * docs.google.com/spreadsheets/d/<THIS PART>/edit
   * The test works in a temporary tab it creates and then deletes, so it
   * cannot disturb existing data.
   */
  SHEET_ID: '',
};

/**
 * Exercise every service and report to the Execution log.
 *
 * ⚠️ THIS DOES NOT TEST THE DEPLOYMENT. It calls the handlers directly,
 * so it proves the Google side works — scopes, advanced service, API
 * access. It says nothing about whether the web app is reachable, whether
 * `SECRET` gates it, or whether the 302 behaves. Those need an HTTP call
 * to the /exec URL; see docs/google-apps-script.md.
 *
 * Everything it creates, it removes: the calendar event is deleted and
 * the Sheets tab is dropped. The one exception is the email, which cannot
 * be unsent — that is why it goes to you by default.
 */
function runSelfTest() {
  const results = [];
  const record = function (name, fn) {
    try {
      results.push('PASS  ' + name + '  ' + (fn() || ''));
    } catch (err) {
      results.push('FAIL  ' + name + '  ' + (err && err.message ? err.message : err));
    }
  };

  record('gmail.send', function () {
    const to = TEST.EMAIL;
    if (!to) throw new Error('set TEST.EMAIL to your own address to run this check');
    sendEmail_({
      to: to,
      subject: 'Converse360 bridge self-test',
      body: 'If you are reading this, gmail.send works. Safe to delete.',
    });
    return '→ ' + to;
  });

  record('calendar.freebusy', function () {
    const from = new Date();
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    const out = checkAvailability_({ from: from.toISOString(), to: to.toISOString() });
    return out.busy.length + ' busy block(s) in the next 24h';
  });

  record('calendar.events + Meet', function () {
    // A week out, so a stray event never lands in this week's view.
    const start = new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const out = createEvent_({
      title: 'Converse360 self-test (auto-deleted)',
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      add_meet: true,
      notify: 'none', // never email attendees from a test
    });
    // Clean up immediately — a test that leaves litter stops being run.
    Calendar.Events.remove(CALENDAR_ID, out.event_id);
    if (!out.meeting_url) throw new Error('event created but no Meet link came back');
    return out.meeting_url + ' (event deleted)';
  });

  if (TEST.SHEET_ID) {
    record('spreadsheets', function () {
      const book = SpreadsheetApp.openById(TEST.SHEET_ID);
      // Its own tab: findRow_ treats row 1 as headers, so running against
      // a real tab would either misread its data or corrupt it.
      const tabName = 'c360-selftest-' + new Date().getTime();
      const tab = book.insertSheet(tabName);
      try {
        tab.appendRow(['ref', 'status']);
        const ref = 'selftest-' + new Date().getTime();

        sheetAppend_({ spreadsheet_id: TEST.SHEET_ID, tab: tabName, values: [ref, 'new'] });

        const found = sheetFind_({
          spreadsheet_id: TEST.SHEET_ID, tab: tabName, column: 'ref', value: ref,
        });
        if (!found.found) throw new Error('appended a row and then could not find it');

        sheetUpdate_({
          spreadsheet_id: TEST.SHEET_ID, tab: tabName,
          column: 'ref', value: ref, values: [ref, 'updated'],
        });
        const after = sheetFind_({
          spreadsheet_id: TEST.SHEET_ID, tab: tabName, column: 'ref', value: ref,
        });
        if (after.values[1] !== 'updated') {
          throw new Error('update did not stick: ' + after.values[1]);
        }
        return 'append + find + update on row ' + found.row;
      } finally {
        // finally, so a mid-test throw still drops the tab.
        book.deleteSheet(tab);
      }
    });
  } else {
    results.push('SKIP  spreadsheets  set TEST.SHEET_ID to include this');
  }

  results.push('SKIP  create_meet  needs the Meet API; use create_event add_meet:true');

  Logger.log('\n' + results.join('\n'));
}
