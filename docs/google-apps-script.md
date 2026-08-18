# Google without OAuth — the Apps Script route

> **Status: an escape hatch, not the plan.** The supported Google
> integration is the OAuth connector in `apps/api/src/connections`
> (see `docs/app-connections.md`). This document describes the
> alternative: scripts the customer installs in their own Google
> account. It exists because it needs **no consent screen of ours, no
> verification review, no CASA, and no 100-user cap** — so it works
> today, while verification is in review.

## Why this works at all

The OAuth connector has Converse360 calling Google's APIs, which is why
Google reviews us. The Apps Script route inverts that: **the script runs
in the customer's account under their own authority**, and talks to
Converse360 over the public API. Google never sees us in the transaction,
so there is nothing for Google to verify.

This is exactly what competitors do. AiSensy's "Google Sheets" integration
is a generated API key plus a pasted script, and its scope is one
sentence — *"Sync contacts from Google Sheets to AiSensy automatically"*.
One direction, one use case. That is not an accident, and the reason is
in the next section.

## Two directions, and they are not equally good

| | Inbound: Sheets → Converse360 | Outbound: Converse360 → Google |
| --- | --- | --- |
| What runs | A script bound to one spreadsheet | A web app deployed at a public URL |
| Credential the customer holds | A Converse360 API key, scoped | **A URL that acts as their Google account** |
| Blast radius if leaked | Someone can add contacts | Someone can send mail as them |
| Google scope | `spreadsheets.currentonly` (one doc) | Full `spreadsheets`, `gmail.send`, `calendar`, `meet` |
| Verdict | **Recommended.** Ship it. | Works. Use knowingly, prefer the connector. |

The asymmetry is the whole point. Inbound gives the script no power over
the customer's Google account beyond the one sheet it lives in. Outbound
requires the customer to publish an endpoint that executes as them —
which is why the connector, with an encrypted refresh token that never
leaves the server, is the better product once verification lands.

---

# Direction A — Sheets → Converse360 (recommended)

Pushes rows from a spreadsheet into the CRM as contacts. Needs **no
backend work**: it calls `POST /api/v1/contacts`, which already exists
([docs/public-api.md](public-api.md)).

Script: [`apps-script/sheet-to-converse360.gs`](apps-script/sheet-to-converse360.gs)

### 1. Create the API key

Dashboard → **Settings → API keys → New API key**. Name it after the
sheet. Grant **`contacts:write` and nothing else** — this key ends up in
a spreadsheet that may be shared with the whole company. Copy it; it is
shown once.

### 2. Prepare the sheet

A header row, and a **`Phone`** column at minimum. Optional: `Name`,
`Email`, `Company`, `Tags` (comma-separated). Add an empty column named
**`Converse360`** — the script writes each row's outcome there, which is
also what stops it re-sending rows.

### 3. Install the script

In the sheet: **Extensions → Apps Script**. Delete the placeholder
`myFunction`, paste the file, and set `API_KEY` (plus `SHEET_NAME` and
`DEFAULT_DIAL_CODE` if they differ). Save.

### 4. Authorize and run

Reload the spreadsheet — a **Converse360** menu appears. Choose **Sync
new rows now**. Google asks for authorization on first run:

- It will say **"Google hasn't verified this app"**. That is the
  customer's *own* script, not ours. **Advanced → Go to (unsafe)** is
  the correct answer here, and it is a one-time prompt.
- Thanks to `@OnlyCurrentDoc` the grant covers **this spreadsheet
  only**, not every sheet they own. Do not remove that annotation.

Rows get `Added 2026-08-19 14:22`, `Matched …` (the phone was already a
contact), or an error you can read in the cell.

### 5. Automate it

**Converse360 → Sync every 5 minutes.**

⚠️ It polls on a timer rather than using `onEdit` **on purpose**: pasting
500 rows fires `onEdit` once for the whole range, so an edit-driven sync
imports one row and silently drops 499.

---

# Direction B — Converse360 → Google (the bridge)

One web app exposing all four services to automations: Gmail send,
Calendar events, Meet links, Sheets read/write.

Script: [`apps-script/converse360-bridge.gs`](apps-script/converse360-bridge.gs)

> ⚠️⚠️ **The deployment URL plus the secret is a credential for the
> customer's Google account.** "Execute as: Me" + "Anyone" means whoever
> holds the URL acts as the deploying user. Never paste it into a shared
> doc or a screenshot. Rotate by redeploying with a new secret.

### 1. Create the script project

[script.google.com](https://script.google.com) → **New project**. Name it
"Converse360 bridge". Paste the file.

Set `SECRET` to something long and random:

```bash
openssl rand -hex 32
```

### 2. Enable the Calendar advanced service

In the editor: **Services → +** → **Calendar API** → Add.

Without it, every calendar call throws `Calendar is not defined`.
`CalendarApp` is not a substitute — it cannot set `conferenceData`, which
is the only way to attach a real Meet link.

### 3. Pin the scopes in the manifest

**Project Settings → ✓ Show "appsscript.json"**, then open the file and
add `oauthScopes`:

```json
{
  "timeZone": "Asia/Kolkata",
  "dependencies": { "enabledAdvancedServices": [
    { "userSymbol": "Calendar", "serviceId": "calendar", "version": "v3" }
  ]},
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "webapp": { "access": "ANYONE_ANONYMOUS", "executeAs": "USER_DEPLOYING" },
  "runtimeVersion": "V8"
}
```

Declaring them explicitly matters: Apps Script otherwise infers scopes
from the code and tends to over-ask. This list is the same shape as the
OAuth connector's — send-only Gmail, no Drive, no restricted scope.

`webapp` pre-sets the deploy dialog, so "Anyone with Google account"
cannot be picked by accident — that setting returns a login page to
Converse360 instead of running.

⚠️ **`meetings.space.created` is deliberately absent**, and
`calendar.events` + `calendar.freebusy` replace the broader `calendar`.
Both verified against a live deployment:

- `Freebusy.query` works under the narrow `calendar.freebusy` scope, so
  the bridge matches the connector's scope pair exactly.
- The standalone `create_meet` action needs the **Google Meet API enabled
  on the script's GCP project**, and an Apps Script project's *default*
  GCP project will not let you enable extra APIs — it 403s with
  `Google Meet API has not been used in project <n> before`. Attaching a
  standard GCP project fixes it, which is acceptable for one internal
  install and not as a step in a customer's setup.
- **`create_event` with `add_meet: true` returns a real `meeting_url`
  through the Calendar API instead** — no Meet API, no GCP work, one less
  scope on the consent screen. Use that for every Meet link.

### 4. Authorize, then deploy

Run `authorizeOnce` from the editor and approve the prompt. Doing it here
means the consent screen appears while you are watching, not during the
first real automation call where it would look like a Converse360 bug.

Then **Deploy → New deployment → Web app**:

| Setting | Value | Why |
| --- | --- | --- |
| Execute as | **Me** | The script must act as the account that owns the mailbox and calendar. |
| Who has access | **Anyone** | Converse360's server calls it without a Google identity. `SECRET` is the actual gate. |

Copy the `/exec` URL.

### 5. Test the deployment before wiring anything

**Two separate things need testing, and one function does not cover both.**

**a. Do the Google integrations work?** Run **`runSelfTest`** from the
editor's function dropdown. It calls the handlers directly and prints a
PASS/FAIL line per service to the Execution log. Set `TEST.SHEET_ID` first
to include the Sheets checks. It deletes the calendar event and the
temporary Sheets tab it creates; only the email cannot be unsent, which is
why it goes to you.

**b. Is the deployed web app reachable and gated?** `runSelfTest` says
nothing about this — it bypasses `doPost` entirely. That needs a real HTTP
call, below.

⚠️ **Do not pass `-X POST` together with `-L`.** `-X` forces the method on
*every* hop, so curl POSTs to the `googleusercontent.com` echo URL, which
only serves GET — you get a Drive "unable to open the file" page and
conclude the script is broken. Use `-d` alone and let curl switch to GET
on the redirect, exactly as a browser would.

```bash
URL='https://script.google.com/macros/s/…/exec'

# 1. Did it run? Expect 302 + a googleusercontent.com location.
curl -s -o /dev/null -w 'status=%{http_code}\n%{redirect_url}\n' \
  -X POST "$URL" -H 'Content-Type: application/json' \
  -d '{"secret":"…","action":"create_meet"}'

# 2. What did it return? Note: NO -X here.
curl -sL "$URL" -H 'Content-Type: application/json' \
  -d '{"secret":"…","action":"create_meet"}'
```

Verified responses from a live deployment:

| Body sent | Response |
| --- | --- |
| valid secret + `create_meet` | `{"ok":true,"action":"create_meet","meeting_url":"https://meet.google.com/…"}` |
| wrong or missing `secret` | `{"ok":false,"error":"unauthorized"}` |
| not JSON | `{"ok":false,"error":"body is not valid JSON"}` |
| — (any of the above) | HTTP **302** on the first hop |

A login page instead of JSON means **Who has access** is not "Anyone".

### 6. Wire it to an automation

Add an **HTTP request** step:

- **URL** — the `/exec` URL
- **Method** — `POST`
- **Body mode** — `json`
- **Body fields** — `secret`, `action`, and that action's fields
- ⚠️ **Ignore HTTP errors** — **ON**. This is not optional; see below.

### ⚠️ Expect a 302, and treat it as success

Google answers a POST to `/exec` with a **302** redirecting to
`googleusercontent.com`, where the response body is served.
[`automation-http.util.ts`](../apps/api/src/automations/services/automation-http.util.ts)
uses `redirect: 'manual'` and deliberately does not follow — a public URL
that 3xx-bounces to an internal address is exactly what that guard
prevents. So:

- The step sees **status 302** and an empty body.
- **302 means the script ran.** Google executes `doPost` on the initial
  request; the redirect only serves the reply.
- Without **Ignore HTTP errors** the step counts 302 as a failure and
  stops the automation *after* the email was already sent.

Verify with `Ignore HTTP errors` on and a condition on
`{{ steps.<key>.status }}` — `302` and `200` are both success, anything
else is not. If you need certainty during setup, check the script's
**Executions** log in the Apps Script editor; that is also the only place
a Google-side error message appears.

### ⚠️ Getting a value back: use `callback`, not the response

Because the body is unreadable, an action's result cannot flow into
`{{ steps.<key>.body }}`. For a Meet link, the script sends it to the
customer itself — add to the body fields:

```json
{
  "secret": "…",
  "action": "create_meet",
  "callback": {
    "type": "message",
    "to": "{{ contact.phone }}",
    "template": "Here's your meeting link: {{meeting_url}}"
  }
}
```

The script creates the space, then calls `POST /api/v1/messages` with the
link substituted in. `callback.type: "webhook"` posts the raw result to
your own URL instead.

This is the one real capability gap versus the connector: with
`app_action`, a Meet link lands in `context.steps[<key>]` and the *next*
step can use it. Through the bridge, the script must deliver it.

### Actions

Every call takes `secret` and `action`, plus optional `callback`.

| Action | Required | Optional |
| --- | --- | --- |
| `send_email` | `to`, `subject`, `body` | `cc`, `bcc`, `reply_to`, `from_name`, `html` |
| `create_event` | `title`, `starts_at`, `ends_at` | `description`, `timezone`, `attendees`, `add_meet`, `notify` |
| `create_meet` | — | ⚠️ needs the Meet API + a standard GCP project. Use `create_event` with `add_meet` instead. |
| `check_availability` | `from`, `to` | — |
| `sheet_append` | `spreadsheet_id`, `values` | `tab` |
| `sheet_find` | `spreadsheet_id`, `column`, `value` | `tab` |
| `sheet_update` | `spreadsheet_id`, `column`, `value`, `values` | `tab` |

Timestamps are ISO 8601 (`2026-08-20T15:00:00+05:30`). `to`, `cc`, `bcc`,
`attendees` and `values` accept an array or a comma-separated string.

---

## Quotas — per customer, and lower than you think

These are the customer's Apps Script quotas, not ours, and they are the
practical ceiling on the bridge:

- **Gmail sending** is the binding one: on the order of **100
  recipients/day on a consumer account**, ~1,500 on Workspace. A business
  sending appointment confirmations can hit that in a busy week.
- **6 minutes** per execution.
- Daily caps on trigger runtime and `UrlFetchApp` calls.

Check [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
for current figures before promising throughput — they differ by account
type and Google revises them. The Gmail API path behind the OAuth
connector has no comparable per-user send cap.

## What this route does not fix

- **No update channel.** The script lives in the customer's account. Ship
  a fix and every customer must re-paste. This is what makes the pattern
  unmanageable past a handful of installs, and the main reason it is an
  escape hatch rather than the product.
- **Blind failures.** Errors land in the customer's Executions log, which
  we cannot read. A connector failure surfaces in our own automation log.
- **Setup friction, forever.** Steps 1–5 versus one "Connect Google"
  button.
- **Restricted scopes are still restricted.** Reading a mailbox needs
  `gmail.readonly` whoever runs it. Doing it inside a customer's script
  does not make it free — it makes it invisible, which is worse. The
  bridge is send-only for the same reason the connector is.

## Where each thing lives

| | Inbound sync | Bridge |
| --- | --- | --- |
| Script | [`apps-script/sheet-to-converse360.gs`](apps-script/sheet-to-converse360.gs) | [`apps-script/converse360-bridge.gs`](apps-script/converse360-bridge.gs) |
| Converse360 side | `POST /api/v1/contacts` | `http_request` automation step |
| Backend changes needed | none | none |
| Google review needed | none | none |
