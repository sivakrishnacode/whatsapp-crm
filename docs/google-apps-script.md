# Google — the Apps Script bridge

> **Migration 092.** Replaces the OAuth connector of 082, which is deleted.
> Code: `apps/api/src/google-script`. Pinned by `google-script.test.ts`.

Gmail, Calendar, Meet and Sheets, reached through **one small script the
customer deploys in their own Google account**.

## Why the direction is inverted

082 had Converse360 calling Google's APIs. That put the whole product behind
Google's OAuth verification review, which costs:

- an **"unverified app" interstitial** on every customer's consent screen
  until the review passes, and
- a hard **100-grant lifetime cap** on the Cloud project — Google states it
  cannot be reset, and it applies to dev and staging projects too, so
  spinning up another project just gives you a different 100 to spend.

Here the script runs under the **customer's own authority** and we only ever
call the script. Google never has to verify us, because we never call Google.
There is no consent screen of ours, no review, no cap, and no CASA question.

**The costs are real, and none of them go away:**

- **No update channel.** The script lives in somebody else's account. A fix
  means every customer re-pastes. This is the single biggest constraint on
  the design and the reason `BRIDGE_VERSION` exists.
- **Per-customer Apps Script quotas.** Consumer Gmail caps sending at roughly
  100 recipients/day (~1,500 on Workspace), with a 6-minute execution limit.
  The Gmail API had no comparable per-user ceiling.
- **Blind failures.** Errors land in the customer's Executions log, which we
  cannot read. Our own `last_error` is a summary, not a stack trace.

## How setup works

One integration, one card, one row — `google_script_connections` is UNIQUE on
`account_id`. A single deployment answers every action, so "connected" has a
single answer. (082 needed four cards because incremental consent made it a
per-scope question. Nothing here is granted incrementally.)

The dashboard walks four steps, two of which happen inside Google:

| Step | Where | What |
| --- | --- | --- |
| 1 | Converse360 | `POST /google-script/provision` mints a secret and returns the script with it already inside |
| 2 | Apps Script | Paste into `Code.gs`, add the **Calendar** advanced service, paste `appsscript.json` |
| 3 | Apps Script | Run `authorizeOnce`, then Deploy → Web app (**Execute as: Me**, **Who has access: Anyone**) |
| 4 | Converse360 | `POST /google-script/url` saves the `/exec` URL, `POST /google-script/test` proves it |

⚠️ **Steps 2 and 3 never show a completion tick.** We cannot observe what
somebody did in the Apps Script editor, and a tick we guessed at would be a
lie. Only steps 1 and 4 have server-side truth. The rail lets you move
anywhere for the same reason — a wizard that blocked on a check it cannot
perform would strand people who had already done the work.

## The parts that are easy to get wrong

⚠️⚠️ **The 302 is the normal case, and it is followed as a `GET`.**
Apps Script answers a POST to `/exec` with a 302 to
`script.googleusercontent.com`, which serves the response body. Replaying the
POST there fetches Google's Drive error page — HTML that reads exactly like a
broken script. That produced a real misdiagnosis in development: a stale
"Who has access is wrong" message that sent someone hunting through Google
settings when the actual cause was a rotated secret.

Following it is also what gives steps their **outputs**. Without the body,
`create_event` could not hand `meeting_url` to the next step and `sheet_find`
could not publish what it found — which is why an earlier draft needed the
script to call *back* into our API, and therefore to hold a Converse360 API
key. **The served script now holds no credential of ours at all.** Keep it
that way.

⚠️ **`normaliseExecUrl` is a host allowlist, not a generic SSRF check.** Our
server POSTs a secret to whatever that field contains, so "is it publicly
routable" — good enough for the `http_request` step — would happily accept an
attacker's collector. `script.google.com` only, `/exec` only. The `/dev` URL
is refused **by name**: it sits next to `/exec` in the Apps Script UI, needs a
signed-in browser, and would fail every automation with a login page.

⚠️ **We mint the secret; the customer never invents one.** Asking somebody to
run `openssl rand -hex 32` and paste it into two places is how `secret123`
reaches production. `provision` is the one response in the product that
contains it. Calling it again mints a **new** secret and orphans whatever is
deployed — correct behaviour, warned about in the UI.

⚠️ **`exec_url` + secret is a credential for the customer's Google account**,
and unlike an OAuth token **we cannot revoke it** — only they can, by deleting
the deployment. So: RLS on with **zero policies** and rights revoked,
AES-256-GCM at rest, decrypted only in `GoogleScriptConnectionService`, never
in a queue payload, a response or a log line. "Disconnect" says plainly that
it revokes our access and not the script's existence.

⚠️ **Restricted scopes are still restricted inside a customer's own script.**
It makes them invisible, not free. `gmail.send` only — there is no draft
action, because `gmail.compose` can read drafts. Nothing lists Drive files;
spreadsheet ids are pasted from the URL and tab names are typed.

⚠️ **There is no standalone Meet action.** Verified against a live deployment:
a Meet space needs the Google Meet API enabled on the script's GCP project,
and an Apps Script *default* project will not allow that — it 403s with
`Google Meet API has not been used in project <n>`. Attaching a standard GCP
project fixes it and is an unacceptable step in a customer's setup.
`create_event` with `add_meet: true` returns a real `meeting_url` through the
Calendar API instead, which is why `meetings.space.created` is absent from the
manifest.

## Adding an action

`google-script.catalog.ts` is the authority, and every id and field key in it
is a **wire contract with scripts already deployed in customers' accounts**.

- **Adding** an action means every customer must re-paste before it works.
  Ship it with a version check, not silently — the bridge echoes
  `BRIDGE_VERSION` in every reply for exactly this.
- **Renaming** an id or a field key breaks live automations against scripts we
  cannot update. They fail with "unknown action" and no way for the customer
  to tell why.

Both halves must change together: `bridge-source.ts` (what customers run) and
the catalogue (what the editor renders and the API validates). `bridge-source.ts`
is the authority for the script — there is deliberately no second copy in
`docs/` to drift from it.

## Automations

One step type, `google_action`. The config names an **action** and its
**fields** — no connection id, no URL, no secret. The deployment is resolved
from the running automation's `account_id`, so 082's `connection_id` trap is
gone by construction rather than guarded: there is no id a hand-edit could
repoint at another workspace.

## Booking forms

085's Google Calendar sync went with the connector. See CLAUDE.md — the
columns survive, `parseAvailability` ignores a stale `calendar` key, and the
three properties to preserve if it is ever rebuilt (busy lookup fails **open**,
busy blocks merge into the same list, the event is created **after** the
booking commits) are recorded there.

---

# Sheets → Converse360 (a separate, manual recipe)

The bridge is Converse360 → Google. The other direction — pushing sheet rows
into the CRM as contacts — needs no bridge and no Google review at all: a
script bound to the spreadsheet calls the **public API** with a Converse360
key.

Script: [`apps-script/sheet-to-converse360.gs`](apps-script/sheet-to-converse360.gs)

1. **Settings → API keys → New API key**, scoped to **`contacts:write` and
   nothing else** — this key lives in a spreadsheet that may be shared widely.
2. Sheet needs a header row with **`Phone`** (optional: `Name`, `Email`,
   `Company`, `Tags`) and an empty **`Converse360`** column for per-row status.
3. **Extensions → Apps Script**, paste the file, set `API_KEY`, save.
4. Reload the sheet → **Converse360 → Sync new rows now**.

Notes worth keeping:

- `@OnlyCurrentDoc` limits the grant to **that one spreadsheet**. Don't remove it.
- It polls on a timer rather than using `onEdit`, because pasting 500 rows
  fires `onEdit` **once** — an edit-driven sync imports one row and silently
  drops 499.
- `POST /api/v1/contacts` is find-or-create by phone, so a re-run matches
  rather than duplicating.
