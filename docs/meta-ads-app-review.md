# Meta App Review pack — Ads Manager

Everything needed to submit the Ads Manager for Meta App Review, in the
order Meta asks for it. This is the **last** milestone (M6): the code is
built and walkable in sandbox, and this is the gate between that and
switching the feature on for real customers.

Companions: [meta-ads-manager.md](meta-ads-manager.md) (design),
[meta-ads-manager-requirements.md](meta-ads-manager-requirements.md) (open
items, env vars).

> **The schedule risk is here, not in the code.** Business Verification
> plus permission review plus Marketing API access tier are three separate
> queues at Meta. Budget weeks. Start this while M2–M3 are still being
> tested rather than after.

---

## 1. Prerequisites, in order

Each blocks the next. Doing them out of order means a rejection that costs
a full review cycle.

| # | Step | Where | Notes |
|---|---|---|---|
| 1 | **Business Verification** | Meta → Business Settings → Security Centre | Legal name, address, and a document that matches. `ads_management` cannot reach advanced access without it. Takes days, sometimes weeks. |
| 2 | **App is Business type, linked to the verified portfolio** | App → Settings → Basic | A Consumer-type app cannot request `ads_management` at all. |
| 3 | **Marketing API product added** | App → Add Product → Marketing API | |
| 4 | **Valid OAuth Redirect URIs** | App → Facebook Login for Business → Settings | Must match `META_ADS_REDIRECT_URI` **exactly**, including scheme and trailing path. `GET /ads/oauth/config` echoes what this server actually sends — copy from there rather than typing it. |
| 5 | **Privacy Policy + Terms URLs, Data Deletion callback** | App → Settings → Basic | Meta rejects submissions without these. Data deletion matters here: we store customer phone hashes in Meta audiences. |
| 6 | **A test user with a test ad account** | App → Roles → Test Users | The reviewer needs to reproduce the flow. See §4. |

---

## 2. Permissions to request

Request all of these in one submission — a second round for a forgotten
permission costs another cycle.

| Permission | Held? | What we do with it | Where in the code |
|---|---|---|---|
| `ads_management` | ❌ **request** | Create and pause campaigns, ad sets, ads and creatives; upload creative media; create audiences and lead forms | `marketing-objects.util.ts`, `ad-publish.service.ts` |
| `ads_read` | ❌ **request** | Read daily insights to report spend and results back to the advertiser | `marketing-insights.util.ts`, `ads-sync.service.ts` |
| `business_management` | ❌ **request** | List the advertiser's business portfolios so they can pick which ad account to use | `getBusinesses` / `getAdAccounts` |
| `pages_show_list` | ✅ | List pages so the advertiser picks which one the ad runs from | `getPages` |
| `pages_read_engagement` | ✅ | Page name for the ad preview | same |
| `pages_manage_ads` | ❌ **request** | Run ads on behalf of the page; create lead forms on it | `marketing-leadforms.util.ts` |
| `leads_retrieval` | ✅ | Pull lead-form submissions into the CRM as contacts | `integrations/controllers/facebook.controller.ts` (predates this feature) |
| `whatsapp_business_management` | ✅ | Resolve the WABA number a Click-to-WhatsApp ad delivers into | `ads-connect.service.ts` |
| `instagram_basic` | ❓ | Only if Instagram placements ship as more than a placement checkbox | not currently required |

### Marketing API access tier — separate from the above

Marketing API has its own tiers: **Development** (own ad accounts only,
low rate limits) → **Basic** → **Standard**. A new app is in Development,
which means it **cannot manage a customer's ad account at all**. Standard
access is its own request under App Review → Marketing API.

**Check which tier the app is on before assuming permission review is the
only blocker.** `readRateLimitUsage` surfaces it: the
`x-ad-account-usage` header carries `ads_api_access_tier`, which is logged
on every Graph response.

---

## 3. Use-case text

Meta wants, per permission: what the app does, why the permission is
necessary, and what the user sees. Drafts below — adapt to house voice,
but keep the specifics. Vague submissions are the most common rejection.

### `ads_management`

> Our product is a WhatsApp CRM. Businesses connect their own Meta ad
> account and create Facebook and Instagram ads whose destination is a
> WhatsApp conversation, a lead form, or their website.
>
> We use `ads_management` to create the campaign, ad set, ad creative and
> ad on the business's own ad account when they press Publish in our
> four-step ad builder, and to pause or resume those ads from our
> dashboard. Every object is created in PAUSED state and only activated
> once all four have been created successfully, so a partial failure never
> results in a live ad the business did not intend.
>
> We never create ads without an explicit action by an authenticated
> administrator of the workspace, and we never move money: ad spend is
> billed by Meta directly to the business's own funding source.

### `ads_read`

> We read `/insights` at campaign, ad set and ad level, once nightly and
> on explicit user request, to show the business what their ads cost and
> produced. We join that spend to the conversations and pipeline deals the
> ads generated inside our CRM — reporting a business cannot get from Ads
> Manager alone, because Meta does not see their sales pipeline.

### `business_management`

> Businesses commonly administer several ad accounts across one or more
> business portfolios. We use `business_management` to list their
> portfolios and the ad accounts within each, so they can choose which one
> our product should use. We read only names and ids; we do not modify
> business settings.

### `pages_manage_ads`

> Ads run from the business's Facebook page, and Meta requires the
> ADVERTISE task on that page. We also create Meta instant (lead-gen)
> forms on the page when a business builds a Lead Form ad. We check for
> the ADVERTISE task when the page is selected and refuse the selection
> with an explanation if it is absent, rather than failing later at
> publish.

---

## 4. Reviewer walkthrough

The reviewer must be able to reproduce the flow. Provide a test user, and
a script that matches what our UI actually does.

### Test credentials to supply

- App test user with the ads permissions granted.
- A test ad account the test user administers, with a funding source (a
  test ad account needs one to pass our own `funding_ok` gate — this is
  worth checking before submitting, because a reviewer hitting "this ad
  account cannot run ads" will reject).
- A test Facebook page with the ADVERTISE task.
- A login for our product on a workspace with `ADS_MANAGER_ENABLED=true`
  and **`ADS_MANAGER_SANDBOX=false`** — the sandbox is for us, not the
  reviewer.

### Script

1. Sign in → **Ads Manager** in the left rail → **Setup**.
2. Press **Connect Facebook**. Consent dialog appears with the ads
   permissions. Choose *Opt into all*.
3. Select a business portfolio, then an ad account. Note that currency and
   timezone appear, read from Meta.
4. Select a Facebook page. (Demonstrate that a page without ADVERTISE is
   offered but refused with a reason.)
5. Press **Link number** to attach the WhatsApp number.
6. Go to **Create Ad**. Choose *Click to WhatsApp Ad*. Name the campaign,
   answer the special-ad-categories question, pick a performance goal.
7. Step 2: add a location, set an age range, pick placements, add one
   interest. Note the estimated audience updating.
8. Step 3: set a daily budget. Note the amount echoed back in the ad
   account's currency.
9. Step 4: write the copy, upload an image, choose the button.
10. Press **Publish**. Show the resulting campaign on **Overview**, with
    its status from Meta.
11. Press **Pause** on the campaign, then **Refresh** to show the status
    reconciling from Meta.
12. Show **Leads**: a Click-to-WhatsApp conversation attributed back to the
    ad that paid for it.

### Screencast notes

- Record with the sandbox **off**. A reviewer who spots fixture data
  ("sandbox_act_1") will reject.
- Show the consent dialog in full, including the permission list.
- Show at least one *refusal* — the page without ADVERTISE, or a budget
  above the ceiling. Reviewers look for whether an app handles the unhappy
  path.
- Do not cut between steps 10 and 11: the reviewer needs to see the ad
  actually appear.

---

## 5. Data handling statements Meta will ask about

Have these answers ready; they come up in the Data Use Checkup as well as
review.

| Question | Answer |
|---|---|
| Do you store Meta access tokens? | Yes. AES-256-GCM encrypted at rest (`common/security/encryption.util.ts`), in `meta_ads_config`. Never returned to any client. Deleted when the user disconnects. |
| Do you send personal data to Meta? | Yes, for custom audiences only: customer phone numbers, **SHA-256 hashed before leaving our server** (`hashAudienceIdentifier`). Never plaintext. `customer_file_source: USER_PROVIDED_ONLY` — the advertiser's own contacts, collected with consent. |
| Do you store ad performance data? | Yes, daily aggregates per campaign/ad set/ad in `meta_ads_insights`. No personal data. |
| Who can access it? | Members of the workspace that owns the connection. Enforced by row-level security plus explicit account scoping in every query (`AdsConfigService`). |
| Data deletion | **Implemented.** `POST /ads/privacy/data-deletion` verifies Meta's `signed_request` HMAC, deletes every `meta_ads_config` row for that `fb_user_id` (taking both encrypted tokens with it), and returns the confirmation code + status URL Meta expects. `POST /ads/privacy/deauthorize` does the same when the app is removed from someone's Facebook settings. |

### The callback URLs to paste into the dashboard

App → Settings → Basic:

| Field | Value |
|---|---|
| Data Deletion Request URL | `https://<api-domain>/ads/privacy/data-deletion` |
| Deauthorize Callback URL | `https://<api-domain>/ads/privacy/deauthorize` |

Notes on the implementation, because two of them are deliberate and would
otherwise look like bugs:

- **Neither endpoint is behind `AdsEnabledGuard`**, unlike every other ads
  route. A deletion request must still be honoured after the feature is
  switched off — gating it would mean the flag silently stops us honouring
  deletions for data we still hold.
- **Mirrored campaigns and insights are NOT deleted.** They are the
  business's own advertising records — spend that happened — and contain no
  personal data about the Facebook user who authorised the connection.
  Deleting a company's spend history because an employee revoked a personal
  grant would destroy the wrong thing. Audiences pushed to Meta are Meta-side
  data and Meta removes those under the same request.
- The status page (`/ads-data-deletion`) is **public and unauthenticated**,
  and deliberately does not confirm whether a given code ever existed —
  that would make it an oracle for "did this Facebook user use this
  product".

---

## 6. Before you submit — checklist

- [ ] Business Verification complete
- [ ] Marketing API access tier confirmed (Development is not enough)
- [ ] Redirect URI in the dashboard matches `GET /ads/oauth/config` exactly
- [ ] Test user + funded test ad account + page with ADVERTISE
- [x] Data-deletion callback implemented (§5) — paste both URLs into the dashboard
- [ ] `ADS_MANAGER_SANDBOX=false` on the environment the reviewer uses
- [ ] Screencast recorded against real Meta, showing one refusal
- [ ] Privacy policy mentions sharing hashed customer identifiers with Meta
- [ ] `ADS_MAX_DAILY_BUDGET_MINOR` set to a real number, not the default

## 7. After approval

1. Set `ADS_MANAGER_ENABLED=true` and `ADS_MANAGER_SANDBOX=false` on the
   API; `NEXT_PUBLIC_ADS_MANAGER_ENABLED=true` on the web app. Both apps
   need a restart — `NEXT_PUBLIC_*` is inlined at build time.
2. Verify the nightly sweep registers: look for
   `Ads sync sweep scheduled (30 2 * * * UTC)` in the API log.
3. Roll out to one friendly account first. The first real publish is the
   only true test of the CTWA `promoted_object` shape and the
   `destination_type` behaviour — both are flagged as unverified in the
   requirements doc.
4. Only then consider `ADS_WHATSAPP_STATUS_ENABLED`, and only after
   confirming the placement exists for the target ad accounts.
