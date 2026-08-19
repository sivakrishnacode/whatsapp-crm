/**
 * Google Form → Converse360 contact.
 *
 * Bound to a Google FORM, not a spreadsheet. Every submission becomes a
 * contact via `POST /api/v1/contacts`, so a business already collecting
 * leads through a Google Form keeps its form and gets them in the CRM.
 *
 * ⚠️ THIS IS THE OPPOSITE DIRECTION FROM THE BRIDGE, AND NEEDS NO GOOGLE
 *    SCOPE FROM US AT ALL.
 *   The bridge is Converse360 → Google, and Converse360 holds a secret for
 *   the customer's script. Here the customer's own form pushes to our
 *   PUBLIC API with a Converse360 key, so Google grants us nothing: the
 *   script reads the form it lives in, under its owner's authority.
 *
 * ⚠️ THE KEY BELOW IS A CONVERSE360 KEY, NOT A GOOGLE ONE.
 *   Scope it to `contacts:write` and nothing else. A form's script project
 *   is visible to every editor of that form.
 *
 * @OnlyCurrentDoc
 */

const CONFIG = {
  API_BASE: 'https://app.converse360.in/api/v1',

  // Settings → API keys → New API key. Scope: contacts:write ONLY.
  API_KEY: 'converse360_live_REPLACE_ME',

  /**
   * Which question answers which contact field, BY THE QUESTION'S TITLE,
   * matched case-insensitively.
   *
   * Titles rather than ids because a form owner reads titles — and because
   * Google's item ids are invisible in the editor, so a mapping keyed on
   * them could not be checked by the person maintaining it. Retitling a
   * question breaks the mapping, which is the trade: it is the readable
   * half of the choice, and the sync logs the mismatch rather than
   * silently dropping the field.
   */
  FIELDS: {
    phone: ['Phone', 'Mobile', 'WhatsApp number'],
    name: ['Name', 'Full name', 'Your name'],
    email: ['Email', 'Email address'],
    company: ['Company', 'Business', 'Organisation'],
  },

  // Prepended when a number arrives with no country code.
  DEFAULT_DIAL_CODE: '+91',

  // Applied to every contact this form creates.
  TAGS: ['google-form'],
};

/**
 * Runs on every submission.
 *
 * ⚠️ MUST BE INSTALLED AS A TRIGGER — see `installTrigger`. A function
 * merely NAMED onFormSubmit does nothing on its own for a form-bound
 * script that has to call an external URL: the simple trigger runs without
 * authorization and `UrlFetchApp` needs it, so the send would fail
 * silently on every real submission while working perfectly when you press
 * Run.
 */
function onFormSubmit(e) {
  if (!e || !e.response) {
    throw new Error('Run installTrigger once; do not run this by hand.');
  }

  const answers = {};
  const items = e.response.getItemResponses();
  for (let i = 0; i < items.length; i++) {
    const title = String(items[i].getItem().getTitle()).trim().toLowerCase();
    answers[title] = items[i].getResponse();
  }

  const pick = function (titles) {
    for (let i = 0; i < titles.length; i++) {
      const value = answers[String(titles[i]).trim().toLowerCase()];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
    return '';
  };

  const rawPhone = pick(CONFIG.FIELDS.phone);
  const phone = toE164_(rawPhone);
  if (!phone) {
    // Loud, not silent: a form whose phone question was renamed would
    // otherwise drop every lead with nothing to show for it.
    throw new Error(
      'No usable phone in this response (saw "' + rawPhone + '"). ' +
        'Check CONFIG.FIELDS.phone matches your question title.'
    );
  }

  const payload = { phone: phone, tags: CONFIG.TAGS };
  const name = pick(CONFIG.FIELDS.name);
  const email = pick(CONFIG.FIELDS.email);
  const company = pick(CONFIG.FIELDS.company);
  if (name) payload.name = name;
  if (email) payload.email = email;
  if (company) payload.company = company;

  const res = UrlFetchApp.fetch(CONFIG.API_BASE + '/contacts', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CONFIG.API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = res.getResponseCode();
  // 201 created, 200 this phone was already a contact — both are success.
  if (status !== 200 && status !== 201) {
    throw new Error('Converse360 returned ' + status + ': ' + res.getContentText().slice(0, 200));
  }
  Logger.log('Synced ' + phone + ' (HTTP ' + status + ')');
}

/**
 * Best-effort E.164, same heuristic as the sheet sync.
 *
 * A 10-digit Indian mobile and a 10-digit US number are indistinguishable
 * without knowing the form, so a wrong guess throws and appears in the
 * executions log rather than creating a contact nobody can message.
 */
function toE164_(raw) {
  const trimmed = String(raw || '').trim();
  const hadPlus = trimmed.charAt(0) === '+';
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (hadPlus) return '+' + digits;
  if (digits.slice(0, 2) === '00') return '+' + digits.slice(2);

  const dial = CONFIG.DEFAULT_DIAL_CODE.replace(/[^0-9]/g, '');
  if (digits.length > 10 && digits.slice(0, dial.length) === dial) return '+' + digits;
  if (digits.length === 10) return '+' + dial + digits;
  return '+' + digits;
}

/** Run this ONCE from the editor. Approve the prompt when it appears. */
function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('onFormSubmit')
    .forForm(FormApp.getActiveForm())
    .onFormSubmit()
    .create();
  Logger.log('Installed. Submit a test response and check Executions.');
}

function removeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onFormSubmit') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}
