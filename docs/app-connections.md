# App Connections — OAuth connectors for Google Sheets, Gmail, Calendar & Meet

> **Status: BUILT. Waiting on Google OAuth verification to go public.**
> Every phase below is implemented (migrations 081 + 082 applied). What is
> NOT done is Phase 0 — the Google Cloud Console setup and the verification
> submission — which is operator work, not code. Until it is, the app runs
> in Testing status: up to 100 test users, an "unverified app" interstitial,
> and refresh tokens that expire after 7 days.
>
> Supersedes the "paste your own URL" premise of
> `apps/web/src/lib/automations/app-presets.ts` for the four Google apps only.
> Read this before touching `src/connections/**` or the `app_action` step type.
>
> **Where the code lives**
> | Piece | Path |
> | --- | --- |
> | Connections core | `apps/api/src/connections/` |
> | Connectors (one file per app) | `apps/api/src/connections/connectors/google/` |
> | Step type | `app_action` — executor case in `automation-step-executor.service.ts` |
> | Activation checks | `AutomationsService.validateAppConnections` |
> | Editor form | `apps/web/src/components/automations/canvas/app-action-fields.tsx` |
> | Integrations cards | `apps/web/src/components/integrations/connected-apps.tsx` |
> | Tests | `connections.test.ts`, `gmail.connector.test.ts` |

## What this delivers

1. **Facebook Leads is removed as a product surface** — the card, the page, the
   FB-JS-SDK connect flow, the Page toggles and the two tables behind them.
2. **Four Google apps become real connectors**: Sheets, Gmail, Calendar, Meet —
   connected once per workspace through a server-side OAuth redirect, tokens
   encrypted and refreshed for you, no API keys pasted anywhere.
3. **Those apps appear in the automation step picker as apps**, each with a
   named action list (Append Row, Send Email, Create Event…) and typed fields —
   not a raw HTTP request wearing a logo.

## The three decisions that shape everything below

### D1 — One `app_action` step type, not one type per action

`AutomationStepType` is a union consumed by an executor switch, a validator, a
DTO, a web registry and a field renderer. Twelve Google actions as twelve union
members is twelve edits in five files per app, forever.

Instead: **one** step type, `app_action`, whose config is
`{ connection_id, provider, action, input }`. The *picker* still shows apps and
actions as first-class entries — it reads them from a connector catalogue, so
"Google Sheets → Append Row" is exactly as discoverable as "Send message"
while the type system stays at 26 members. Adding an app is one connector file
plus one registry line; adding an action to an existing app is one array entry.

This is the same registry shape as `src/ads/services/ad-types/` and
`ai/lib/skills.ts`, both of which earned it the same way.

### D2 — One connection per Google *account*, scopes granted incrementally

Not one connection per service. A workspace connects `ops@acme.com` once;
`app_connections.scopes[]` records what that grant covers. Each action declares
the scopes it needs; picking an action whose scope is missing triggers an
incremental re-consent (`include_granted_scopes=true`) rather than a second
connection row.

Why it matters beyond tidiness: asking for `gmail.send` when somebody only
wants to append a spreadsheet row is how you fail your own OAuth verification
review, and it is how a user decides not to connect at all.

### D3 — Facebook Leads goes from Integrations, and only from Integrations

**Decided.** Lead ingestion stays working for Ads Manager.

`/webhooks/facebook-leads` has a second consumer. The Ads Manager's lead-form
ad type (built, gated behind `ADS_MANAGER_ENABLED`) publishes Meta lead forms
whose submissions arrive on that endpoint — three files in `src/ads` say so in
their header comments.

So deleting the module wholesale would silently gut a finished feature. Phase 1
instead **deletes the user-facing integration** — card, page, FB-JS-SDK connect,
Page toggles, both tables — and **moves the webhook + `FacebookLeadService` into
`src/ads`**, re-pointing its page-token lookup from `facebook_pages` to
`meta_ads_config` (which already stores an encrypted page token for exactly this
Page). Net effect: Facebook Leads disappears from Integrations; Ads Manager lead
ads keep working, and the code that serves them now lives in the module that
owns them.

---

## Phase 0 — Google Cloud Console, step by step

Do this first and do it early: the console work is quick, the **review it starts
is the long pole of the whole project**. Console UI labels move around (the
OAuth consent screen now lives under "Google Auth Platform"); the concepts below
are stable even when the menu names are not.

### 1. Project

New project, e.g. **converse360-connectors**. A separate project from anything
Supabase sign-in uses — verification, scopes and quotas are all per-project, and
you do not want a Gmail review blocking your login button.

### 2. Enable the four APIs

*APIs & Services → Library*, enable each:

- **Google Sheets API**
- **Gmail API**
- **Google Calendar API**
- **Google Meet API**

Enabling an API is not consent. It only makes the endpoint callable at all.

### 3. OAuth consent screen / branding

*APIs & Services → OAuth consent screen* (a.k.a. Google Auth Platform → Branding).

- User type **External**.
- App name, support email, app logo (120×120 PNG).
- **App domain**: home page, privacy policy URL, terms of service URL. All three
  must be live, on your own domain, and reachable without a login.
- **Authorised domains**: `converse360.in`.
- Verify domain ownership in Google Search Console with the same account.
- Developer contact email.

### 4. Scopes

Add exactly these and nothing else. Each extra scope is more review, a longer
consent screen, and a better reason for a customer to click Cancel.

| Scope | For | Class |
| --- | --- | --- |
| `openid`, `email`, `profile` | Naming the connection (`ops@acme.com`) | Non-sensitive |
| `.../auth/spreadsheets` | Sheets: append, update, find | **Sensitive** |
| `.../auth/calendar.events` | Calendar: create/update/delete events, Meet-in-invite | **Sensitive** |
| `.../auth/calendar.freebusy` | `check_availability` only | **Sensitive** |
| `.../auth/meetings.space.created` | Standalone Meet links | **Sensitive** |
| `.../auth/gmail.send` | Sending mail | **Sensitive** |

⚠️ **No restricted scope appears in that list, and that is a design constraint,
not an accident.** Restricted scopes are the wide-access ones — `mail.google.com`,
`gmail.readonly`, `gmail.modify`, `gmail.metadata`, `drive`/`drive.readonly` — and
any one of them turns an annual third-party CASA security assessment into a
permanent operating cost. `gmail.send` grants send-only and is merely sensitive,
so the whole catalogue clears on verification alone. Anything that needs to
*read* a mailbox or list a Drive folder is therefore out of scope by policy, not
by oversight; see "Explicitly out of scope".

The app never asks for all of these at once — Phase 2/D2 requests only the
scopes an action needs, incrementally. But the consent screen must declare the
full set up front, which is why the list is worth arguing about now.

### 5. OAuth client

*Credentials → Create credentials → OAuth client ID → **Web application***.

- **Authorised redirect URIs** — exact strings, no wildcards, no trailing slash:
  - `https://api.converse360.in/connections/oauth/callback`
  - `http://localhost:8001/connections/oauth/callback`
- Authorised JavaScript origins: **leave empty**. This is a server-side redirect
  flow; no page JavaScript ever touches a Google token, same decision as the Ads
  Manager connect flow.

Copy the client id and secret into `apps/api/.env`, and onto the VPS:

```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://api.converse360.in/connections/oauth/callback
CONNECTIONS_STATE_SECRET=<openssl rand -hex 32>
```

`CONNECTIONS_STATE_SECRET` is its own secret on purpose — a state minted for
this flow must not be replayable into Instagram's or Ads Manager's.

### 6. Test users (this is what unblocks development)

While publishing status is **Testing**, add your own Google accounts under Test
users — up to 100. They get the full flow, all scopes, no review. Everything in
Phases 2–6 can be built and demoed here.

Two limits to plan around: the "Google hasn't verified this app" interstitial,
and refresh tokens issued to a Testing-status app **expire after 7 days**. Your
dev connection dying weekly is the app working correctly, not a bug — but the
`needs_reauth` handling in Phase 2 had better be right, because you will be its
first user.

### 7. Verification — start it, then keep building

Submit for verification once branding and scopes are settled.

**Every scope in this build is sensitive, so all four apps clear on the same
review**: a brand check, a demo video showing each scope actually being used,
and a written justification per scope. Weeks, typically, with back-and-forth.
One submission, one queue, no per-app gating — there is no reason to hold Gmail
behind a flag when it ships on the same approval as Sheets.

**No CASA.** The annual third-party security assessment applies to *restricted*
scopes only. The catalogue deliberately contains none, which is why
`send_email` exists and `read_inbox` does not.

The one thing to protect: a future "read the customer's reply" feature would
need `gmail.readonly`, and adding it converts this project from a one-off
verification into a recurring paid assessment plus an annual recertification.
That is a business decision, not a ticket.

### 8. Quotas, later

Default per-project quotas (Sheets 300 write req/min, Gmail 250 quota-units/user/sec,
Calendar 600 req/min) are generous for automation traffic but shared across every
workspace you connect — the same "one key serves every tenant" problem as the
platform Gemini key. Watch them in *APIs & Services → Quotas* once real accounts
are on it; request increases before they bite, not after.

---

## Phase 1 — Remove Facebook Leads

**Delete**
- `apps/web/src/app/(dashboard)/integrations/facebook/page.tsx`
- `apps/web/src/components/settings/facebook-leads-config.tsx`
- The Facebook Leads card in `apps/web/src/app/(dashboard)/integrations/page.tsx`
  (lines ~279–325) and its `facebook_connections` read in `fetchStatuses`
- `FacebookController` (the `@Controller('integrations/facebook')` half of
  `apps/api/src/integrations/controllers/facebook.controller.ts`) — connect,
  page listing, page sync toggle, and the demo/sandbox mock path

**Move, do not delete** → `apps/api/src/ads/`
- `FacebookLeadsWebhookController` → `src/ads/controllers/lead-webhook.controller.ts`
- `FacebookLeadService` → `src/ads/services/lead-ingest.service.ts`
- `lead-fetch.processor.ts` → `src/ads/queues/`
- Registration moves from `IntegrationsModule` to `AdsModule`

**Rewire** the page lookup in the ingest service:
`prisma.facebook_pages.findFirst({ page_id })` → `prisma.meta_ads_config.findFirst({ page_id })`,
decrypting `page_access_token` through `AdsConfigService` (the single place an
ads token is decrypted — do not add a second). `is_syncing` has no equivalent
there; the gate becomes "this account has a connected page and lead terms
accepted", which `meta_ads_config` already records.

**Keep unchanged**
- `LEAD_FETCH_QUEUE = 'lead-fetch'` in `queue.constants.ts` — renaming strands
  any job already in Redis, and the constants file stays the single source.
- `whatsapp-embedded-signup-button.tsx`. It loads the FB JS SDK for WhatsApp
  embedded signup and only *mentions* the leads config in a comment. Untouched.

**Migration `081_drop_facebook_leads.sql`**
```sql
drop table if exists public.facebook_pages;
drop table if exists public.facebook_connections;
```
Plus the two relation fields on `Account` in `packages/database/prisma/schema.prisma`
(lines 589–590) and the two models (1444–1476). `ctwa_*` is unrelated and stays.

**Verify**: `ADS_MANAGER_ENABLED=true ADS_MANAGER_SANDBOX=true`, publish a lead-form
ad, POST a fixture lead at the webhook, assert a contact + deal + conversation.

---

## Phase 2 — The connections core (`apps/api/src/connections/`)

Provider-agnostic. Nothing in here knows what a spreadsheet is.

### Migration `082_app_connections.sql`

```sql
create table public.app_connections (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts(id) on delete cascade,
  provider            text not null,                       -- 'google'
  external_account_id text not null,                       -- Google 'sub'
  display_name        text,                                -- ops@acme.com
  scopes              text[] not null default '{}',
  access_token        text not null,                       -- AES-256-GCM
  refresh_token       text,                                -- AES-256-GCM
  token_expires_at    timestamptz,
  status              text not null default 'active',      -- active|needs_reauth|revoked
  last_error          text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (account_id, provider, external_account_id)
);
create index idx_app_connections_account on public.app_connections(account_id);

alter table public.app_connections enable row level security;
revoke all on public.app_connections from anon, authenticated;
```

⚠️ **RLS on, zero policies, rights revoked — deliberately, like `admin_audit_log`.**
RLS is row-level, not column-level: any browser-readable policy exposes
`refresh_token` to PostgREST. The API is the only reader, and it returns a
redacted projection. This is the whole reason the table is not on the
`facebook_connections` pattern, which stores its token in plaintext (see the
tenant-scoping section of `CLAUDE.md` — that pattern is a known outstanding bug,
not a precedent).

### Module layout

```
apps/api/src/connections/
  connections.module.ts
  connections.types.ts              # Connector / Action / FieldSpec contracts
  controllers/
    connections.controller.ts       # SupabaseAuthGuard — list, start, delete, resources
    connections-oauth.controller.ts # NO guard — the callback; authorised by signed state
  services/
    connection.service.ts           # CRUD, account-scoped, redacted projections
    connection-token.service.ts     # ⚠️ THE ONLY PLACE A TOKEN IS DECRYPTED
    oauth-flow.service.ts           # authorize URL, code exchange, revoke
    connector-registry.service.ts   # provider id -> Connector
    connector-execution.service.ts  # run one action
  connectors/
    google/
      google.oauth.ts               # shared endpoints, scope constants, userinfo
      google-sheets.connector.ts
      gmail.connector.ts
      google-calendar.connector.ts
      google-meet.connector.ts
  utils/
    connections-oauth-state.util.ts # binds common/security/oauth-state.util to its own secret
    google-api.util.ts              # fetch wrapper: named options, bounded body, typed errors
```

### Endpoints

| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| GET | `/connections` | Supabase | Connected accounts, redacted, + catalogue status |
| GET | `/connections/catalog` | Supabase | Apps + actions + field specs (the editor's authority) |
| GET | `/connections/:provider/oauth/start` | Supabase | 302 to Google. `?scopes=` for incremental consent |
| GET | `/connections/oauth/callback` | **none** | Cross-site GET; authorised by HMAC state |
| DELETE | `/connections/:id` | Supabase | Revoke at Google, then delete the row |
| GET | `/connections/:id/resources/:kind` | Supabase | Dropdown data — `calendars`, `sheet_tabs`, `gmail_from` |

One rewrite line in `apps/web/next.config.ts`:
`{ source: "/api/connections/:path*", destination: `${nestApiUrl}/connections/:path*` }`.

### Non-negotiables

- **Callback authorisation is the signed state, nothing else.** Same mechanism
  and same reasoning as `ads/oauth/callback`: reuse
  `common/security/oauth-state.util.ts`, sign with `CONNECTIONS_STATE_SECRET`,
  carry `{accountId, userId, returnTo}`, 10-minute TTL. A null decode aborts the
  flow — never "proceed with defaults".
- **PKCE (S256) in addition to the state**, since Google supports it for web
  clients and the code lands on a URL that may sit in a browser history.
- **`access_type=offline`, and never overwrite a stored refresh token with
  null.** Google returns a refresh token on first consent only; a re-consent
  that omits it must leave the stored one alone or the connection silently dies
  at the next expiry.
- **Refresh happens in `connection-token.service.ts` and nowhere else**, with a
  120-second expiry skew and a per-connection in-process lock so ten concurrent
  automation runs do not fire ten refreshes (Google invalidates older ones on
  some flows). A `invalid_grant` sets `status = 'needs_reauth'` — the run fails
  visibly rather than retrying forever.
- **No token in a queue payload, a log line, or an API response.** Redis stores
  job data in plaintext and Bull Board renders it; the processor re-reads and
  decrypts. Same rule as the AI platform key and the ads token.
- **Redirects are not followed** on Google calls, and hosts are an allowlist
  (`*.googleapis.com`, `oauth2.googleapis.com`). The SSRF guard in
  `common/security/ssrf.util.ts` exists for *user-supplied* URLs; these are ours,
  so an allowlist is both stricter and cheaper. A connector that wants an
  arbitrary host does not get one.

---

## Phase 3 — The connector contract and the four apps

```ts
export interface ConnectorAction {
  id: string;                       // 'append_row'
  label: string;                    // 'Append row'
  description: string;              // one line, shown in the picker
  scopes: string[];                 // what this action alone needs
  inputs: FieldSpec[];              // renders the form AND validates the config
  outputShape: string[];            // token paths the editor can suggest
  execute(ctx: ActionContext): Promise<ActionResult>;
}

export interface Connector {
  provider: 'google';
  app: string;                      // 'google_sheets'
  name: string;                     // 'Google Sheets'
  blurb: string;
  actions: ConnectorAction[];
  resources?: Record<string, (ctx: ResourceContext) => Promise<Option[]>>;
}
```

`FieldSpec` is the single description of a field: kind (`text` | `long_text` |
`number` | `boolean` | `select` | `resource_select` | `key_values` | `email_list`),
label, help, required, and whether it accepts `{{ tokens }}`. The API validates
against it and the web renders from it, so a field cannot exist in the form but
not the validator — the failure mode that `contact_matches_segment_rule()` vs
`lib/segments/rules.ts` warns about in `CLAUDE.md`.

### The catalogue

**Google Sheets** — scope `.../auth/spreadsheets`
| Action | Inputs | Output |
| --- | --- | --- |
| `append_row` | spreadsheet id/URL, tab (resource), values per column | `updated_range`, `row_number` |
| `update_row` | spreadsheet, tab, match column + value, values | `updated_range`, `matched` |
| `find_row` | spreadsheet, tab, match column + value | `found`, `row`, `row_number` |
| `create_spreadsheet` | title, headers | `spreadsheet_id`, `url` |

> Listing a user's spreadsheets needs the Drive API and a second sensitive
> scope. Not worth it: the spreadsheet id is pasted from the URL (accepting a
> full URL and extracting the id), and **tabs** are then listed from
> `spreadsheets.get` — which is the dropdown people actually need.

**Gmail** — scope `.../auth/gmail.send` (sensitive, send-only, no CASA)
| Action | Inputs | Output |
| --- | --- | --- |
| `send_email` | to, cc, bcc, subject, body (+ html toggle), reply-to | `message_id`, `thread_id` |
| `send_reply` | thread id, body | `message_id` |

RFC-2822 assembled server-side, base64url, `users.messages.send`. The From
address is the connected account — not a free-text field, because a spoofable
From is a phishing feature.

⚠️ `send_reply` takes its `thread_id` from **an earlier `send_email` step in the
same automation** (`{{ steps.notify.thread_id }}`). It cannot search for a thread
and must not grow that ability: searching means `gmail.readonly`, and
`gmail.readonly` means CASA. The field help text has to say this, or the first
person to use it will ask for a thread picker.

⚠️⚠️ **`gmail.send` is the ONLY Gmail scope that avoids CASA, and "just save a
draft instead" is a trap.** The intuition is that drafting is the gentler,
lower-privilege option. Google classifies it the other way round, and is right
to: `gmail.compose` can create, read, update and delete drafts, which is read
access to user content. Verified against Google's scope table —

| Scope | Class | CASA |
| --- | --- | --- |
| `gmail.send` | Sensitive | no |
| `gmail.compose` | **Restricted** | **yes** |
| `gmail.readonly`, `gmail.modify`, `gmail.metadata`, `gmail.insert`, `gmail.settings.*`, `mail.google.com` | Restricted | yes |

So there is no `create_draft` action and there must never be one. Send-only is
not a limitation we accepted reluctantly — it is the entire reason this
connector costs nothing to keep running.

**Google Calendar** — scope `.../auth/calendar.events` (+ `calendar.freebusy`
only for the availability action)
| Action | Inputs | Output |
| --- | --- | --- |
| `create_event` | calendar (resource), title, description, start, end, timezone, attendees, **add Meet link** | `event_id`, `html_link`, `meet_link` |
| `update_event` | event id, any of the above | `event_id` |
| `delete_event` | event id | `deleted` |
| `find_events` | calendar, time window, query | `events[]` |
| `check_availability` | calendar(s), window | `busy[]`, `is_free` |

**Google Meet** — scope `.../auth/meetings.space.created`
| Action | Inputs | Output |
| --- | --- | --- |
| `create_meet_space` | (none) | `meeting_uri`, `meeting_code` |

Two honest paths to a Meet link and both are offered, because they are
different things: `create_event` with the conference checkbox produces a link
*attached to a calendar invite* (`conferenceData.createRequest`,
`conferenceDataVersion=1`); `create_meet_space` produces a standalone link with
no calendar entry. ⚠️ Verify the Meet REST v2 `spaces.create` contract against
live Google docs at implementation time rather than trusting this table.

---

## Phase 4 — Automations integration

### API

1. `automation.types.ts` — add `'app_action'` to `AutomationStepType` and an
   `AppActionStepConfig extends CommonStepOptions` with
   `{ connection_id, app, action, input: Record<string, unknown> }`.
2. `dto/step.dto.ts` — validate the shape; the *input* is validated against the
   action's `FieldSpec[]` by the registry, not by a DTO per action.
3. `automation-step-executor.service.ts` — one new case. It resolves the
   connection **scoped to `automation.accountId`** (a `connection_id` in a
   config blob is attacker-influenced the same way a segment id is), interpolates
   every string input through `automation-interpolation.util.ts`, then delegates
   to `ConnectorExecutionService`. The result publishes to
   `context.steps[<key>]` exactly like an HTTP step, **including on failure**
   when `on_error: 'continue'`, so a condition can branch on what came back.
4. `automation-validate.ts` — activation blockers: unknown app/action, missing
   connection, `status !== 'active'`, missing required input, scope not granted.
   This remains the only thing that blocks activation.
5. `automation-step-preview.service.ts` — preview renders the resolved request
   without sending; test mode runs it for real. Google has no dry-run, so the
   Test tab must say plainly that running `send_email` sends an email.

### Web

| File | Change |
| --- | --- |
| `lib/automations/step-meta.tsx` | One `app_action` entry, category `orchestration`. Label and icon resolve from the catalogue per-step, so a node reads "Google Sheets · Append row", never "App action". |
| `lib/automations/connectors.ts` *(new)* | Client-side catalogue types + helpers. Data is **fetched**, not duplicated — the API is the authority. |
| `canvas/resources.tsx` | Extend `AutomationResourcesProvider` to fetch `/api/connections` and `/api/connections/catalog` once, alongside members/flows/sample-data. |
| `canvas/add-step-dialog.tsx` | An **Apps** section above the existing URL presets: real connectors first, each expanding to its actions, with a "Not connected" chip and an inline Connect that opens the OAuth start URL. The 11 `app-presets.ts` entries stay for everything else. |
| `canvas/step-fields.tsx` | `AppActionFields`: connection picker → action picker → fields rendered from `FieldSpec[]`, with `resource_select` fetching `/api/connections/:id/resources/:kind` and every text field being a `TokenInput`. |
| `lib/automations/availability.ts` | App actions are channel-independent → always `full`. They send nothing through a channel. |
| `lib/automations/diagnostics.ts` | New checks: connection disconnected / needs re-auth, action removed from catalogue, required input empty, scope not granted. Mirrors run-time behaviour, as that file is required to. |

### `app-presets.ts` — amend, don't delete

Its header currently argues there is no OAuth on purpose. That stays true for
Slack, Notion, Airtable and the rest; it stops being true for Google. Update the
comment to say which apps graduated and why, and **remove the `google_sheets`
preset** — two Google Sheets entries in one picker, one real and one asking for
an Apps Script URL, is worse than either alone.

---

## Phase 5 — Integrations page

Rebuild the card grid from the catalogue instead of four hand-written cards, so
a new connector appears without editing the page. Each Google card shows the
connected account's email, granted scopes in plain words ("Can send email as
ops@acme.com"), a **Disconnect** that revokes at Google first, and a
`needs_reauth` state that is visually distinct from disconnected — an expired
grant with automations pointing at it is an incident, not a blank slate.

Shopify, WooCommerce and Zapier keep their current cards and their current
credential model. They are not in scope.

---

## Phase 6 — Tests, docs, deploy

**Vitest (api)** — `oauth-state` round-trip incl. tamper/expiry; refresh-skew and
`invalid_grant` → `needs_reauth`; refresh-token-not-overwritten-with-null;
cross-account `connection_id` is refused; token never present in a serialised
job payload or a redacted API response; `FieldSpec` validation rejects unknown
and missing inputs; one contract test per action asserting the request it builds.

**Vitest (web)** — catalogue-driven picker renders every action; diagnostics fire
on a disconnected connection; `app_action` node label resolution.

**Docs** — this file, plus a `CLAUDE.md` section (App Connections, next to
Automations) recording D1–D3 and the token rules, since that file is what the
next agent reads.

**Deploy** — `./scripts/deploy.sh`. Migrations 081 and 082 applied to the live
DB before the API rolls, since 081 drops tables the old code still reads.

---

## Explicitly out of scope

Everything in this first group is excluded for **one reason**: it needs a
restricted scope, and a restricted scope means an annual CASA assessment. They
are not "later" items — each one changes what this project costs to run.

- **Reading a mailbox.** No inbox view, no "when an email arrives" trigger, no
  thread search, no label management. (`gmail.readonly` / `gmail.modify` /
  `mail.google.com`.)
- **Browsing Drive.** No "pick a spreadsheet from a list", no file browser.
  Spreadsheet ids are pasted from the URL. (`drive` / `drive.readonly`.)
- **Reading someone's full calendar history** beyond the event and free/busy
  actions listed above.

And this group is excluded on effort, not policy:

- **Google triggers** ("when a row is added"). That needs polling or Drive push
  channels with renewal — a separate build, not a step type.
- Docs, Slides, Chat.
- Non-Google connectors. The core is provider-agnostic so the second provider is
  a `connectors/<x>/` directory, but nothing else is planned here.
- Migrating Shopify / WooCommerce / Zapier off their key-based auth.
- Per-user (rather than per-workspace) Google connections. One workspace, one
  connected Google account per provider identity; personal Gmail sending per
  agent is a different product decision.

## Rough sequencing

| Phase | Depends on | Notes |
| --- | --- | --- |
| 0 · Google Cloud setup | — | Start the consent-screen review **immediately**; it is the long pole. |
| 1 · Remove FB Leads | — | Independent; can land first and alone. |
| 2 · Connections core | 0 | Testable end-to-end with one throwaway scope. |
| 3 · Connectors | 2 | Sheets → Calendar → Meet → Gmail. All four ship together; no per-app flag. |
| 4 · Automations | 3 | The bulk of the web work. |
| 5 · Integrations page | 2 | Can overlap Phase 4. |
| 6 · Tests & deploy | all | Test users cover everything; public launch waits on verification. |
