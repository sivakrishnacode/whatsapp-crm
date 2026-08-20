# Converse360 · Meta App Review rundown

**App `2068974207093441` · business portfolio `594370617051042`**

Three submissions, ten permissions, three screencasts. Everything you paste into
Meta and everything you point a camera at, in the order it has to happen.

Companions: [meta-platform-setup.md](meta-platform-setup.md) (the operator
runbook for the whole Meta surface), [meta-ads-app-review.md](meta-ads-app-review.md)
(the Ads-only pack, written earlier — it still lists Facebook Lead Ads as a
launch surface, which migration 081 removed; **this file is newer where they
disagree**), [instagram.md](instagram.md), [meta-ads-manager.md](meta-ads-manager.md).

| | |
|---|---|
| Business verification | Verified (23 Aug 2025) |
| App mode | Development |
| WhatsApp | Connected |
| Instagram | Connected |
| Ads | Can publish |
| Permissions held | 0 of 10 |

---

## 1. First, the thing that isn't a form — Tech Provider

**There is nothing to submit. You are already one.**

Tech Provider is not an approval or an application — it is a business model, and
you have already built it. What makes it usable by strangers is App Review
granting **Advanced Access** on the WhatsApp permissions. That is the only gate.

| Model | Who pays Meta for conversations | You |
|---|---|---|
| **Tech Provider** | The customer, on their own WABA | **This is you** |
| Solution Partner (BSP) | You hold a credit line and rebill | Ruled out by decision |

Your Embedded Signup configuration `2186048992251581`, onboarding customers onto
their own WABAs with your app subscribed to each, **is** the Tech Provider
mechanism. Nothing further to configure.

### One product obligation this model creates

Under Tech Provider the customer adds a payment method to **their own** WABA.
Until they do, they can *receive* messages but every business-initiated
conversation fails. Your onboarding must say this explicitly — if it doesn't,
the silence reads as a bug in your product and arrives as a support ticket.

---

## 2. Sequence — by revenue, not by difficulty

Permissions are reviewed individually, so one stalling never blocks another. But
each submission needs its own screencast, and screencasts are where review cycles
get lost. **Submit the one that unblocks selling first.**

### Submission 1 · WhatsApp — unblocks going Live

- `whatsapp_business_management`
- `whatsapp_business_messaging`
- `business_management`

The product. Nothing can be sold until these three are Advanced.

### Submission 2 · Instagram — second channel

- `instagram_business_basic`
- `instagram_business_manage_messages`
- `instagram_business_manage_comments`

Can be submitted the same day as WhatsApp — separate queue, separate screencast.

### Submission 3 · Ads — then a second, longer gate

- `ads_management`
- `ads_read`
- `pages_manage_ads`
- `pages_show_list`
- `pages_read_engagement`
- `leads_retrieval`

Approval here is **not enough**. Marketing API **Full Access** is a separate gate
needing 500+ real API calls over 15 days at under 15% error rate — which is why
your ad account is already live and accruing them.

### ⚠️ Do not request these

`pages_manage_metadata` and any **Facebook Lead Ads** request. That integration
was deleted in migration 081 and the permission appears nowhere in the codebase.
Requesting a permission you cannot demonstrate is a rejection, and it takes the
whole submission down with it.

---

## 3. Paste-ready use-case text

Meta wants three things per permission: what the app does, why the permission is
necessary, and what the user sees. Vague submissions are the single most common
rejection — "we need to read messages" fails. Each block below names the
concrete feature and the human action that triggers it.

### Submission 1 · WhatsApp

#### `whatsapp_business_management`

> Our product is a WhatsApp CRM and shared team inbox. Businesses connect their
> own WhatsApp Business Account through Embedded Signup. We operate as a Tech
> Provider: each business adds its own payment method to its own WABA and Meta
> bills them directly. We never hold a line of credit and never resell
> conversations.
>
> We use this permission to register the phone number the business selected for
> Cloud API, to subscribe our app to their WABA so their inbound messages reach
> their inbox, to read the number's display name and quality rating shown in our
> Settings screen, to submit and manage the message templates the business
> authors in our template editor, and to read their messaging limits so
> broadcast sending stays inside their tier.
>
> Every one of those calls happens either during a connection the business
> explicitly initiated, or on a template the business wrote and submitted itself.

#### `whatsapp_business_messaging`

> This permission is the product. Inbound customer messages arrive on our
> webhook and appear in a shared team inbox where agents reply. Outbound sends
> are agent replies typed in that inbox, approved template messages for
> broadcasts the business schedules itself, and automated replies the business
> configured in our no-code automation builder. Delivery and read receipts
> update each message's status in the thread.
>
> Every send is on behalf of the business that owns the number, initiated either
> by a signed-in team member or by an automation that business built. We honour
> the 24-hour customer service window: outside it our composer requires an
> approved template rather than letting a send fail at the API.

#### `business_management`

> Businesses commonly administer several WhatsApp Business Accounts and ad
> accounts across one or more business portfolios. We use this permission to
> list their portfolios and the assets inside each, so that during connection
> they can choose which WABA, ad account and Facebook Page our product should
> use. We read names and ids only. We never modify business settings.

### Submission 2 · Instagram

#### `instagram_business_basic`

> We use this permission to read the connected professional account's id,
> username and profile picture. The username and picture are shown in our
> Settings screen so the business can confirm which account is connected, and
> they identify the account on every conversation in the inbox. The account id
> is also how we resolve which business an inbound webhook belongs to, since
> that id is the only routing key the webhook carries.

#### `instagram_business_manage_messages`

> Instagram Direct is a channel in our shared team inbox, alongside WhatsApp. We
> use this permission to receive direct messages customers send to the
> business's professional account, and to send the replies their agents write.
> Instagram threads carry the same assignment, notes and tagging as every other
> channel, so one team answers Instagram from the same place they answer
> WhatsApp.
>
> We respect Instagram's 24-hour messaging window and do not send outside it.
> There is deliberately no Instagram broadcast feature in our product: Instagram
> has no template mechanism, so a broadcast could not be compliant, and we do
> not offer one.

#### `instagram_business_manage_comments`

> Businesses moderate the comments on their own posts from inside our inbox. We
> use this permission to read comments and @mentions on the business's own
> media, to reply publicly, to hide or delete a comment the business chooses to
> moderate, and to send a private reply to a commenter — one per comment, within
> Instagram's seven-day limit — when the business has configured a
> comment-to-DM flow.
>
> Every such flow is created and switched on by the business itself. The feature
> is off by default at the workspace level, because it messages people who have
> not messaged the business first.

### Submission 3 · Ads

#### `ads_management`

> Businesses connect their own Meta ad account and create Facebook and Instagram
> ads whose destination is a WhatsApp conversation, a lead form, or their
> website. We use this permission to create the campaign, ad set, ad creative
> and ad on the business's own ad account when they press Publish in our
> four-step ad builder, and to pause or resume those ads from our dashboard.
>
> Every object is created in PAUSED state and only activated once all four have
> been created successfully, so a partial failure never leaves a live ad the
> business did not intend. We never create ads without an explicit action by an
> authenticated administrator of the workspace, and we never move money: ad
> spend is billed by Meta directly to the business's own funding source.

#### `ads_read`

> We read insights at campaign, ad set and ad level, once nightly and on
> explicit user request, to show the business what their ads cost and produced.
> We then join that spend to the conversations and pipeline deals the ads
> generated inside our CRM — reporting a business cannot get from Ads Manager
> alone, because Meta does not see their sales pipeline.

#### `pages_manage_ads`

> Ads run from the business's own Facebook Page, and Meta requires the ADVERTISE
> task on that Page. We also create Meta instant lead-generation forms on the
> Page when a business builds a Lead Form ad. We check for the ADVERTISE task at
> the moment the Page is selected and refuse the selection with an explanation
> if it is absent, rather than failing later at publish time.

#### `pages_show_list`

> We use this permission to list the Pages the business administers, so they can
> choose which Page an ad appears from during setup. It is a read of names and
> ids to populate one dropdown. We never post to a Page.

#### `pages_read_engagement`

> We read the selected Page's name and profile picture so the ad preview in our
> builder shows what the ad will actually look like when it runs, and so our
> Settings screen can confirm which Page is currently selected.

#### `leads_retrieval`

> When a business runs a Lead Form ad, we use this permission to pull each
> submission into our CRM as a contact, so their sales team follows the lead up
> in the same inbox and pipeline as every other enquiry. We fetch submissions
> only from lead forms on the Page that business connected to our product.

---

## 4. Screencast 1 · WhatsApp — one unbroken take

**Read this before you press record**

- **No cuts.** Partial or edited videos are the top rejection reason. One take,
  narrated aloud in English.
- **Disconnect first.** The reviewer must see the connection being *made*, not a
  connection that already exists.
- **Two devices in frame.** Screen recording plus a phone the customer messages
  from. Point the camera at the phone, or use a phone mirror on screen — the
  reviewer must see the message land on a real device.
- **Show the consent dialog in full**, including the whole permission list,
  before you click through it.

| # | Beat | What must be visible |
|---|---|---|
| 01 | Start signed out at `app.converse360.in`. Sign in. | A real product behind authentication |
| 02 | Settings → Channels → WhatsApp, **disconnected**. Say aloud: "This business has not yet connected WhatsApp." | The empty state |
| 03 | Click **Connect with Facebook**. Let the consent dialog render fully and pause on it. | "Manage your WhatsApp accounts", "Manage and access conversations", and your Privacy Policy / Terms links |
| 04 | Walk Embedded Signup end to end: business portfolio → WABA → phone number → SMS verification → accept Meta's terms. | Narrate that the business supplies its own number and its own payment method |
| 05 | Return to the app. Show the connected card. | Verified name, display number, quality rating, "receiving events since" |
| 06 | On the phone, as a customer, send a WhatsApp message to that number. Say what you are typing. | The customer's device sending |
| 07 | Cut back to the screen **without stopping the recording**. | Inbound message in the Inbox, contact created automatically |
| 08 | Reply from the inbox as an agent. Show it arriving on the phone. | The full round trip on both devices |
| 09 | **Refusal beat — do not skip.** Open a conversation whose last customer message is older than 24 hours. Show the composer refusing free text and requiring an approved template. | Reviewers specifically check the unhappy path |
| 10 | Open the template editor. Show a business-authored template and its approval status read back from Meta. | Justifies `whatsapp_business_management` |
| 11 | Settings → Team. Several members, one inbox, one connected number. | Justifies the "shared team inbox" claim in the use-case text |

---

## 5. Screencast 2 · Instagram — one unbroken take

**Two setup traps that make this recording fail silently**

- The Instagram account must be **Professional** (Business or Creator). A
  personal account cannot use the messaging API at all.
- Settings → Messages and story replies → Message controls → **Allow access to
  messages must be ON**. If it is off, webhooks never fire and there is no error
  anywhere. Check it *before* you record.
- You need a **second Instagram account** to play the customer.

| # | Beat | What must be visible |
|---|---|---|
| 01 | Sign in. Settings → Channels → Instagram, disconnected. | The empty state |
| 02 | Click **Connect**. Redirect to instagram.com. Pause on the consent screen. | Messages and comments permissions, named |
| 03 | Approve. Return to the app showing the connected account. | Username and profile picture — justifies `instagram_business_basic` |
| 04 | From the second account on a phone, send a DM to the business account. | The customer's device sending |
| 05 | The DM appears in the Inbox. Reply as an agent. Show it arriving back on the phone. | `instagram_business_manage_messages`, both directions |
| 06 | Same thread carrying assignment, a note and a tag. | Supports the "one inbox, every channel" claim |
| 07 | From the second account, comment on one of the business account's posts. | |
| 08 | The comment appears in the app. Reply publicly, and show the reply on Instagram. | `instagram_business_manage_comments` |
| 09 | Hide that comment from the app, and show it hidden on Instagram. | The moderation half of the same permission |
| 10 | **Refusal beat — do not skip.** Open Broadcasts and show WhatsApp is the only channel available. Say why: Instagram has no template mechanism, so a broadcast could not be compliant. | This is a restraint reviewers rarely see, and it is the strongest signal in the whole video |

---

## 6. Screencast 3 · Ads — one unbroken take

**Record against real Meta.** `ADS_MANAGER_SANDBOX` is already `false` on your
server, which is correct. A reviewer who spots a fixture id like `sandbox_act_1`
in the recording will reject. Verify before recording by opening
`/ads/oauth/config` and confirming `"sandbox": false`.

| # | Beat | What must be visible |
|---|---|---|
| 01 | Sign in → Ads Manager in the left rail → Setup, disconnected. | |
| 02 | Press **Connect Facebook**. Pause on the consent dialog with the ads permissions listed. Opt into all. | Narrate: this is a server-side redirect, not the JS SDK — the token never reaches the browser |
| 03 | Select a business portfolio, then an ad account. | Currency and timezone appearing, read live from Meta — justifies `business_management` |
| 04 | Select the Facebook Page. Then **Link number** to attach the WhatsApp number. | `pages_show_list`, `pages_read_engagement` |
| 05 | Checklist reaching **Ready to advertise**, including `funding_ok` confirmed from Meta. | Say plainly that Meta bills the advertiser directly and you never touch ad spend |
| 06 | Create Ad → Click to WhatsApp. Name the campaign, answer the special ad categories question, pick a performance goal. | |
| 07 | Step 2: a location, an age range, placements, one interest. | The audience estimate updating |
| 08 | Step 3: set a daily budget. | The amount echoed back in the ad account's own currency |
| 09 | **Refusal beat — do not skip.** Try a daily budget above ₹500. Show it refused by the server-side ceiling with a reason. | Explain that budgets travel as minor units to Graph, so the ceiling makes a unit-conversion bug impossible to spend through |
| 10 | Step 4: copy, image, button. Press **Publish**. | |
| 11 | **Do not cut here.** The campaign appears on Overview with its status read back from Meta. | The ad actually existing after publish |
| 12 | Press **Pause**, then **Refresh** to show the status reconciling from Meta. | The management half of `ads_management` |
| 13 | Open Leads. A Click-to-WhatsApp conversation attributed back to the ad that paid for it, with the spend figure beside it. | `ads_read` and `leads_retrieval` — and the whole argument for the product |

---

## 7. Reviewer instructions

**App Settings → Basic → Provide testing instructions.** Meta flags this field as
required and it is where a reviewer goes when your screencast leaves them a
question. Give them a workspace that **already has the channels connected**, so a
reviewer who fails the connect step can still see the product working.

```text
What this app is: Converse360 is a CRM and shared team inbox for businesses that
talk to their customers on WhatsApp and Instagram. Businesses connect their own
WhatsApp Business Account and their own Instagram professional account. We are a
Tech Provider: each business adds its own payment method to its own WABA and
Meta bills them directly.

Test login
URL: https://app.converse360.in
Email: [REVIEWER DEMO EMAIL]
Password: [REVIEWER DEMO PASSWORD]

This workspace already has a WhatsApp number and an Instagram professional
account connected, so the inbox has real conversations in it.

To see inbound and outbound messaging: sign in, open Inbox from the left rail,
open any conversation, and reply. To see the connection flow itself, go to
Settings → Channels → WhatsApp and press Connect with Facebook.

To see Instagram comment moderation: Inbox → filter to Instagram → open a thread
with a comment, where you can reply publicly or hide the comment.

To see the ad builder: Ads Manager → Setup shows the connected ad account;
Create Ad walks the four-step builder. Ads are created paused.

Note on the 24-hour window: if a conversation's last customer message is older
than 24 hours, the composer will require an approved template instead of free
text. This is intentional and matches Meta's policy.
```

⚠️ **Create the demo account before you submit.** Sign up a second workspace,
connect the channels to it, seed a handful of real conversations, and put those
credentials above. **Do not hand a reviewer your own production login** — they
will change things.

---

## 8. Data-handling answers

Asked at review, and again at every annual Data Use Checkup.

| Question | Your answer |
|---|---|
| **Do you store Meta access tokens?** | Yes. AES-256-GCM encrypted at rest, never returned to any client, never placed in a queue payload or a log line. Deleted when the user disconnects. |
| **Do you send personal data to Meta?** | Only for custom audiences: customer phone numbers, SHA-256 hashed before leaving our server, never plaintext, marked `USER_PROVIDED_ONLY` — the advertiser's own contacts, collected with consent. |
| **Do you store message content?** | Yes — it is the inbox. Scoped to the workspace that owns the conversation, enforced by row-level security plus explicit account scoping in every query. |
| **Do you train AI models on it?** | No. Our AI assistant is scoped to the business's own knowledge base, and no customer message content is used to train or develop any model. This is stated explicitly in the privacy policy. |
| **Data deletion** | Implemented. Callbacks verify Meta's `signed_request` HMAC, delete the connection rows with their encrypted tokens, and return the confirmation code and status URL Meta expects. |
| **Who can access the data?** | Members of the workspace that owns the connection, and nobody else. Every tenant boundary is enforced server-side. |

### ⚠️ The one honest gap — close it before you submit

Your privacy policy (`apps/site/privacy.html`, retention table) and your terms
(`apps/site/terms.html`) both promise that messages and contacts are purged **90
days after a subscription ends**. Nothing in the codebase does that today —
there is no scheduled purge anywhere in `apps/api`. It is a promise without a
mechanism. **Either build the sweep or soften the wording** — but do not submit
with a published claim you cannot demonstrate.

---

## 9. Pre-flight

- [x] **Business Verification complete** — verified 23 Aug 2025
- [ ] **App is Business type, on the verified portfolio**
- [ ] **Privacy Policy, Terms and data-deletion URLs** set in App Settings → Basic
- [ ] **All five use cases added; webhooks subscribed** — WhatsApp 3 fields, Instagram 8 fields
- [ ] **Ads redirect URI matches `/ads/oauth/config` exactly**
- [ ] **`ADS_MANAGER_SANDBOX=false`** and a real budget ceiling set (₹500/day)
- [ ] **Two Facebook Login for Business fields filled** — Deauthorize callback and Data Deletion Request URL, on the **FLB Settings** page, *separate* from the ones in App Settings → Basic. Still empty last time I looked.
- [ ] **Legal entity name reconciled** — the portfolio says "rangaraj PRADEEP KUMAR"; the privacy policy says "Conceps Media Works". Name it as a sole proprietorship of the verified individual so the two agree.
- [ ] **90-day purge either built or reworded**
- [ ] **Demo workspace created** with channels connected
- [ ] **Messaging round trip verified on both channels** — do this before recording, not on camera
- [ ] **Three screencasts recorded**, each with its refusal beat
- [x] **App still in Development mode** — correct. Flip to Live only after WhatsApp is approved.

---

## 10. Going live, after the first approval

1. Confirm all three WhatsApp permissions read **Advanced Access** in App Review
   → Permissions and Features.
2. Flip the app from **Development** to **Live** at the top of the dashboard.
3. Onboard one friendly customer and watch their whole journey, including the
   payment-method step on their own WABA.
4. **Instagram** follows the same day its approval lands. Nothing to deploy — it
   is already configured.
5. **Ads** waits for the second gate: 500+ Marketing API calls over 15 days at
   under 15% error rate, then apply for **Marketing API Full Access**. Only then
   can a customer connect their own ad account.

### Two things to diarise, because both fail silently and both fail late

- **Instagram tokens expire every 60 days.** A daily sweep renews anything within
  10 days of expiry. If that job stops, every Instagram connection in the system
  dies 60 days later, all at once, and each business must reauthorise by hand.
- **WhatsApp has no equivalent sweep.** Your current token came back with no
  expiry, but the column exists and the UI warns at 7 days. Build the refresh
  before you have customers you cannot phone.

---

*Prepared 18 August 2026. Permission text is drawn from what the code actually
does — if a feature changes, change the justification with it.*
