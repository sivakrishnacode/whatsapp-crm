/**
 * Sheet → Converse360 contact sync.
 *
 * Pastes into a spreadsheet's own Apps Script project and pushes rows to
 * `POST /api/v1/contacts` with a Converse360 API key. Converse360 never
 * calls Google here — the script reads the sheet under the owner's own
 * authority — so this needs no OAuth verification, no consent screen of
 * ours, and no Google review.
 *
 * The key in CONFIG is a CONVERSE360 key, not a Google one. Scope it to
 * `contacts:write` and nothing else: this file lives in a spreadsheet
 * that may be shared with the whole company.
 *
 * `@OnlyCurrentDoc` is load-bearing. Without it Apps Script asks the
 * owner for access to ALL their spreadsheets; with it the grant is
 * limited to this one document, which is both correct and a far less
 * alarming authorization prompt.
 *
 * @OnlyCurrentDoc
 */

const CONFIG = {
  // Production. `https://api.converse360.in/v1` also works if that host's
  // path allowlist includes /v1; the app origin is proxied and proven.
  API_BASE: 'https://app.converse360.in/api/v1',

  // Settings → API keys → New API key. Scope: contacts:write ONLY.
  API_KEY: 'converse360_live_REPLACE_ME',

  // Tab to read. Must match exactly.
  SHEET_NAME: 'Leads',

  // Row holding the column names. Data starts on the row after it.
  HEADER_ROW: 1,

  // Header text → what it means. Rename freely; only `phone` is required.
  // `status` is written back BY this script — add that column yourself.
  COLUMNS: {
    phone: 'Phone',
    name: 'Name',
    email: 'Email',
    company: 'Company',
    tags: 'Tags',
    status: 'Converse360',
  },

  // Prepended when a number has no country code. Indian default.
  DEFAULT_DIAL_CODE: '+91',

  // Applied to every contact this script creates, on top of the row's own
  // Tags cell. Makes "where did this contact come from?" answerable.
  TAGS: ['sheet-import'],

  // Ceiling per run. Apps Script kills an execution at 6 minutes, and a
  // partial run is fine — the next run resumes from the first unsynced
  // row.
  MAX_ROWS_PER_RUN: 200,

  // Pause between calls, milliseconds. Keeps a 5,000-row paste from
  // tripping the per-key rate limit.
  THROTTLE_MS: 200,
};

/**
 * Sync every row that has no status yet.
 *
 * Safe to re-run: the endpoint is find-or-create by phone, so a row that
 * somehow syncs twice returns the same contact rather than duplicating
 * it. The status column exists to save calls and to show errors, not to
 * guarantee correctness.
 */
function syncNewRows() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    throw new Error('No tab named "' + CONFIG.SHEET_NAME + '". Check CONFIG.SHEET_NAME.');
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= CONFIG.HEADER_ROW) return; // headers only

  const headers = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const col = resolveColumns_(headers);

  const firstDataRow = CONFIG.HEADER_ROW + 1;
  const rows = sheet
    .getRange(firstDataRow, 1, lastRow - CONFIG.HEADER_ROW, lastCol)
    .getValues();

  let done = 0;
  let failed = 0;

  for (let i = 0; i < rows.length && done + failed < CONFIG.MAX_ROWS_PER_RUN; i++) {
    const row = rows[i];
    const sheetRow = firstDataRow + i;

    // Already handled on an earlier run.
    if (col.status !== -1 && String(row[col.status]).trim() !== '') continue;

    const rawPhone = String(row[col.phone] || '').trim();
    if (rawPhone === '') continue; // blank row, not an error

    const phone = toE164_(rawPhone);
    if (!phone) {
      writeStatus_(sheet, sheetRow, col.status, 'Bad phone: ' + rawPhone);
      failed++;
      continue;
    }

    const payload = { phone: phone, tags: buildTags_(row, col) };
    if (col.name !== -1 && row[col.name]) payload.name = String(row[col.name]).trim();
    if (col.email !== -1 && row[col.email]) payload.email = String(row[col.email]).trim();
    if (col.company !== -1 && row[col.company]) {
      payload.company = String(row[col.company]).trim();
    }

    const result = postContact_(payload);
    if (result.ok) {
      // 201 = created, 200 = this phone was already a contact.
      const verb = result.status === 201 ? 'Added' : 'Matched';
      writeStatus_(sheet, sheetRow, col.status, verb + ' ' + nowStamp_());
      done++;
    } else {
      writeStatus_(sheet, sheetRow, col.status, 'Error ' + result.status + ': ' + result.message);
      failed++;
    }

    Utilities.sleep(CONFIG.THROTTLE_MS);
  }

  SpreadsheetApp.getActive().toast(done + ' synced, ' + failed + ' failed', 'Converse360', 5);
}

/** POST one contact. Never throws — the caller writes the outcome into the sheet. */
function postContact_(payload) {
  let res;
  try {
    res = UrlFetchApp.fetch(CONFIG.API_BASE + '/contacts', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + CONFIG.API_KEY },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true, // read the status ourselves
    });
  } catch (err) {
    return { ok: false, status: 0, message: String(err) };
  }

  const status = res.getResponseCode();
  const text = res.getContentText();
  if (status === 200 || status === 201) return { ok: true, status: status };

  // The API's error envelope is { error: { code, message } }.
  let message = text.slice(0, 200);
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
  } catch (ignored) {
    // Non-JSON body (a proxy error page). The raw slice is the best we have.
  }
  return { ok: false, status: status, message: message };
}

/** Header text → column index, -1 when the column is absent. */
function resolveColumns_(headers) {
  const find = function (name) {
    for (let i = 0; i < headers.length; i++) {
      if (String(headers[i]).trim().toLowerCase() === String(name).trim().toLowerCase()) {
        return i;
      }
    }
    return -1;
  };

  const col = {
    phone: find(CONFIG.COLUMNS.phone),
    name: find(CONFIG.COLUMNS.name),
    email: find(CONFIG.COLUMNS.email),
    company: find(CONFIG.COLUMNS.company),
    tags: find(CONFIG.COLUMNS.tags),
    status: find(CONFIG.COLUMNS.status),
  };

  if (col.phone === -1) {
    throw new Error(
      'No "' + CONFIG.COLUMNS.phone + '" column on row ' + CONFIG.HEADER_ROW + '. ' +
        'Phone is the only required field.',
    );
  }
  return col;
}

/** Row's own Tags cell (comma-separated) plus CONFIG.TAGS, deduped. */
function buildTags_(row, col) {
  const tags = CONFIG.TAGS.slice();
  if (col.tags !== -1 && row[col.tags]) {
    String(row[col.tags])
      .split(',')
      .forEach(function (t) {
        const clean = t.trim();
        if (clean !== '' && tags.indexOf(clean) === -1) tags.push(clean);
      });
  }
  return tags;
}

/**
 * Best-effort E.164. The API requires it and rejects anything else.
 *
 * A heuristic, deliberately: a 10-digit Indian mobile and a 10-digit US
 * number are indistinguishable without knowing the sheet. Wrong guesses
 * surface in the status column rather than silently creating a contact
 * nobody can message. Put real E.164 in the sheet if you can.
 */
function toE164_(raw) {
  const trimmed = String(raw).trim();
  const hadPlus = trimmed.charAt(0) === '+';
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (hadPlus) return '+' + digits;

  // 00 as an international prefix.
  if (digits.slice(0, 2) === '00') return '+' + digits.slice(2);

  const dial = CONFIG.DEFAULT_DIAL_CODE.replace(/[^0-9]/g, '');
  // Already carries the dial code (e.g. 919876543210 for +91).
  if (digits.length > 10 && digits.slice(0, dial.length) === dial) return '+' + digits;
  if (digits.length === 10) return '+' + dial + digits;
  return '+' + digits;
}

function writeStatus_(sheet, row, statusCol, text) {
  if (statusCol === -1) return; // no status column configured
  sheet.getRange(row, statusCol + 1).setValue(text);
}

function nowStamp_() {
  return Utilities.formatDate(
    new Date(),
    SpreadsheetApp.getActive().getSpreadsheetTimeZone(),
    'yyyy-MM-dd HH:mm',
  );
}

/** Menu, so nobody has to open the script editor to run a sync. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Converse360')
    .addItem('Sync new rows now', 'syncNewRows')
    .addItem('Sync every 5 minutes', 'installTimeTrigger')
    .addItem('Stop automatic sync', 'removeTriggers')
    .addToUi();
}

/**
 * Time-driven trigger, not onEdit.
 *
 * A paste of 500 rows fires onEdit ONCE for the whole range, so an
 * onEdit-based sync silently imports one row and drops 499. Polling
 * every 5 minutes catches pastes, typing, and rows added by other
 * scripts alike.
 */
function installTimeTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('syncNewRows').timeBased().everyMinutes(5).create();
  SpreadsheetApp.getActive().toast('Syncing every 5 minutes.', 'Converse360', 5);
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNewRows') ScriptApp.deleteTrigger(t);
  });
}
