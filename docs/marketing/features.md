# Converse360 — Feature Guide

> **Audience:** marketing, sales, onboarding and support. This is the
> "what can it actually do today" reference — every capability below is
> **built and running in production**. Anything not yet shippable lives in
> [roadmap.md](roadmap.md) instead, so this file can be quoted on a
> website, a deck or a sales call without a caveat.
>
> Last verified against the codebase: **12 August 2026**.

---

## The one-line version

**Converse360 turns WhatsApp, Instagram and your website into one inbox —
then puts an AI agent, a CRM and an automation engine behind it.**

Most "WhatsApp tools" are a broadcast blaster with a chat window bolted on.
Converse360 is built the other way round: the conversation is the record, and
contacts, deals, automations, campaigns and revenue all hang off it.

### Who it's for

| Segment | The problem it solves |
| --- | --- |
| D2C / e-commerce brands | Abandoned-cart and order-status conversations that a human can't keep up with |
| Service businesses (clinics, salons, tuition, real estate) | Enquiries arriving on three platforms at 11pm, and bookings that never get followed up |
| Agencies & resellers | One dashboard to run many clients' WhatsApp presence, with an API to plug into their own stack |
| Sales teams | WhatsApp leads that die in a personal phone with no pipeline, no owner and no history |

---

## 1. One inbox, three channels

Contacts, conversations and messages are **shared across every channel** and
tagged with the platform they arrived on. The same person who DMs you on
Instagram and later messages your WhatsApp is one contact with one history —
not three orphaned threads.

| Channel | Status | What it does |
| --- | --- | --- |
| **WhatsApp** | Live | Official **Meta WhatsApp Cloud API** — your own verified business number, your own template library, your own quality rating |
| **Instagram** | Live | DMs, story replies, and public comments on your posts |
| **Website** | Live | An embeddable chat widget that talks to the same inbox |
| **Voice / phone** | Coming soon | See [roadmap](roadmap.md#voice-channel) |

### What the inbox itself gives an agent

- **Real-time threads** with delivery and read receipts straight from Meta.
- **Rich messages both ways** — text, images, video, documents, **voice notes**
  (recorded in the browser), emoji **reactions**, and quoted replies.
- **Message templates** picked inline, so an agent can re-open a conversation
  outside WhatsApp's 24-hour window without leaving the thread.
- **Product cards** — send a single product or a product list straight from
  your catalogue into the chat.
- **Assignment** — hand a conversation to a specific teammate; presence shows
  who is actually online.
- **Per-row triage** — close, reopen or mark a conversation from the list
  without opening it (so it doesn't get marked read by accident).
- **A contact sidebar in the thread** — tags, custom fields, segments, notes,
  deals and past activity next to the conversation, not a click away.
- **Pause the AI on one thread.** The moment a human replies, the bot steps
  back on that conversation automatically — it never talks over an agent
  mid-sentence. It can also be toggled by hand from the thread header.

---

## 2. The AI agent

An AI agent that answers customers on **every channel at once**, using your
own business knowledge — and that you can actually configure rather than
"train" by hope.

### Two ways to power it, chosen per workspace

| Mode | How it bills | Who it's for |
| --- | --- | --- |
| **Built-in AI** (default) | Runs on our AI key, metered in **credits**. Every new workspace starts with **250 free credits** | Anyone who wants to switch it on and see it work in 60 seconds |
| **Your own key (BYOK)** | Your OpenAI / Anthropic / Gemini key, encrypted at rest. Your provider bills you directly — **we meter nothing and cap nothing** | Larger teams with existing AI contracts or volume pricing |

Credit top-up packs: **1,000 / 3,000 / 10,000 / 25,000 credits**, paid by
Razorpay. A credit is charged from **real token usage**, not per message — a
one-line answer costs a fraction of a long researched one.

### Agent Studio — six tabs, no prompt engineering required

| Tab | What you set up |
| --- | --- |
| **Persona** | Who the agent is, what the business does, its voice, and the **ground rules** it must never break ("never promise same-day delivery") |
| **Knowledge** | Upload PDFs and Word documents, paste text, or point it at a page on your site to crawl. It answers from your material, with retrieval — one knowledge base serves WhatsApp, Instagram and web alike |
| **Skills** | Switch on capabilities: **FAQ & support**, **lead qualification**, **order status**, **product recommendations**, **returns & refunds**, **appointments**, **human handoff** |
| **Actions** | Connect your own API as a tool the agent can call. You configure the endpoint, method and headers; the model may only fill in the declared parameters — so it cannot be talked into calling somewhere else |
| **Behaviour** | Test mode (answer only up to 3 nominated numbers while you evaluate it), escalation rules, when to hand off |
| **Provider** | Built-in credits or your own key, and which model |

- **A test drawer, not a separate playground.** You can try the agent from
  whichever form you just edited — and it runs the *exact* assembly production
  uses. What you test is what customers get.
- **Draft-reply button in the inbox.** The same agent will write a reply for a
  human to check and send, for teams that want AI assistance without AI
  autonomy.
- **Instagram DM agents** and **web-widget agents** are the same engine, so
  behaviour is consistent across channels.

---

## 3. Automations — the no-code rules engine

**Trigger → steps.** Channel-agnostic by design: one automation answers a
WhatsApp message and an Instagram DM without being written twice.

**Triggers (15):** new message received · first-ever inbound message ·
keyword match · new contact created · conversation assigned · tag added ·
time / schedule · Instagram comment · Instagram story reply · web chat
started · form submitted · appointment booked · appointment cancelled ·
appointment rescheduled

**Steps (16):** send message · send template · add tag · remove tag ·
**add to segment** · remove from segment · assign conversation · update a
contact field · create a deal · wait · condition (if/then branching) ·
send webhook · close conversation · send a form · send a booking link

Every run is logged, so you can see what fired, on whom, and what happened.

---

## 4. Flows — the visual conversation builder

A drag-and-drop canvas (with auto-layout) for building guided conversations —
menus, qualification scripts, FAQ bots — that run turn by turn against a real
customer.

**Node types:** start · send message · send buttons · send list · send media ·
**collect input** · condition · set tag · **set segment** · handoff to human ·
end

**Triggers:** keyword · first inbound message · manual start.

**What makes it survive contact with real customers:**

- **A fallback policy per flow.** Decide what happens when someone types
  something unexpected: re-prompt (how many times), hand off to a human, or
  ignore. Then decide what happens when the re-prompts run out.
- **Timeouts are swept automatically**, so abandoned flows don't sit open
  forever holding a customer hostage.
- **An agent replying pauses the flow**, same as the AI bot.
- **Starter templates:** Welcome menu, FAQ bot, Lead capture.
- **Native WhatsApp Flows** (Meta's own in-app form experience) are supported
  separately, as an asset you can build and send.

---

## 5. Contacts & CRM

- **Contacts** with name, phone, email, company, avatar, source, and the
  channel they came from.
- **Custom fields** you define per workspace.
- **Tags** — facts about a person ("vip", "refunded").
- **Segments** — named audiences with a purpose ("March webinar attendees"),
  and the feature that stops your tag list becoming sixty entries nobody dares
  delete. Two kinds:
  - **Static** — an explicit list. Anything can file someone into it.
  - **Dynamic** — a saved filter, recomputed on every read. Membership is
    always current without anyone maintaining it.
- **Six ways to file someone into a segment**: the contacts bulk bar, the
  contact drawer, the inbox sidebar, CSV import, an automation step, a flow
  node, or the public API. Each membership records **how** it happened — an
  automation adding 10,000 people is visibly a different fact from an operator
  ticking a box.
- **CSV import** with field mapping.
- **Search and filter** across tags, segments, company and Instagram username.
- **Notes and activity history** per contact.

### Pipelines

Multiple pipelines, custom stages, drag-and-drop deals, deal values in your
workspace currency, and **deals created automatically** by an automation step
or a flow node. Ad spend can be attributed through to the deal it produced.

---

## 6. Broadcasts & campaigns

- **Template broadcasts** to a segment, a tag, a filter or an uploaded list —
  sent through the official API, so they're compliant, not grey-market.
- **Audience by segments** (several unioned), plus **exclude segments** —
  because "everyone except last month's buyers" is the shape most suppression
  lists take.
- **Per-recipient template variables**, so a "broadcast" is still personal.
- **Scheduled campaigns** for a date and time.
- **Real send infrastructure.** Every broadcast fans out onto a job queue:
  one job per recipient, retried intelligently when Meta throttles, and
  **resumed automatically if the server restarts mid-send**. Status moves
  `draft → queued → sending → sent`, and you can watch it.
- **Per-recipient delivery status** — sent, delivered, read, failed, with the
  reason.
- **WhatsApp messaging-limit awareness** — the dashboard shows your current
  Meta tier, so a large broadcast doesn't quietly burn your quality rating.

---

## 7. Commerce

- **WhatsApp catalogue** — products synced to your WhatsApp Business catalogue
  and sendable as cards in a chat.
- **Orders** — WhatsApp orders captured and listed.
- **Store sync** — connect **Shopify** (OAuth) or **WooCommerce**. Products
  sync on a queue, so a big catalogue doesn't block the dashboard.
- The AI agent's **order status** and **product recommendation** skills read
  this data, scoped to the contact asking — so it can tell one customer about
  *their* order without becoming an order-lookup oracle for your whole store.

---

## 8. Forms & bookings

- **A hosted form builder** — build it, publish it, get a public link.
- **Booking pages** — a form carrying a slot picker. Availability, business
  hours, and slots that can't be double-booked (enforced in the database, not
  hopefully in the app).
- **Send a form or a booking link from an automation, a flow, or a chat.**
  On the web widget it renders **inline as a card** rather than throwing the
  visitor into a new tab for two questions.
- **Submissions** land against the contact, and **`form_submitted` /
  `appointment_booked` / `cancelled` / `rescheduled` are automation triggers** —
  so a booking can confirm itself, tag the person, and create the deal.

---

## 9. The website channel

- **An embeddable widget** — position, light/dark/auto theme, greeting,
  business hours.
- **Live streaming replies** to the visitor, no page refresh.
- **An offline path.** Outside business hours it can show a form instead of a
  dead chat box, or let the visitor message anyway and pick it up in the
  morning.
- **Sessions analytics** — who visited, what they asked.
- **Media upload from the visitor**, handled safely.

---

## 10. Instagram

- **DMs and story replies** in the shared inbox.
- **Comment management** — read and reply to comments on your posts.
- **Comment funnels** — someone comments a keyword on a post, and you DM them
  automatically. The classic Instagram growth mechanic, with a delay you
  control so it doesn't look like a bot.
- **Intents** — group and route responses by what people actually wanted.
- **Posts** browsing, so you can pick the post a funnel applies to.
- **Real names, not IDs** — Instagram identities are resolved, so your inbox
  shows a person, not a numeric handle.

---

## 11. Click-to-WhatsApp & lead ads

- **Click-to-WhatsApp attribution.** When someone clicks a CTWA ad and lands
  in your WhatsApp, the click is captured and tied to the conversation — so
  you can see which campaign produced which conversation, and which deal.
- **Facebook lead forms** — leads fetched from connected Pages onto a queue
  and turned into contacts.
- **Retargeting audiences** built from your own conversation data.

---

## 12. Team, workspace & governance

- **Multi-tenant workspaces.** Every query is account-scoped; one workspace
  can never see another's data.
- **Four roles:** owner · admin · agent · viewer.
- **Invitations** by email with a role attached.
- **Workspace branding** — name and logo.
- **Notifications** with an in-app bell.
- **Settings**: your profile, login & security, appearance, fields & tags,
  deals & currency, API keys, and plan & billing.
- **Billing is owner-only.** An admin runs the workspace; the owner is the one
  who pays for it, and only they see the billing surface.
- **Guided onboarding.** A two-step welcome (workspace + plan), then a
  channel-connect checklist that tracks what's still unconnected.

---

## 13. Analytics

The home dashboard: conversation volume over time, response times, a pipeline
donut, key metric cards, your WhatsApp messaging tier, quick actions, and a
live activity feed. Per-surface analytics sit with their feature — broadcast
delivery, web sessions, CTWA clicks, ad insights.

---

## 14. Developer platform

- **A public REST API** (`/api/v1`) covering **messages, contacts,
  conversations, broadcasts, segments** and **webhook management**.
- **API keys** created in Settings, **account-scoped**, with **granular
  scopes** (`messages:send`, `contacts:read`, `broadcasts:send`, …). Keys are
  shown once and stored only as a hash. Revocation leaves an audit trail.
- **Outbound webhooks** — subscribe your own endpoint to events, delivered on
  a retrying queue.
- **A Zapier integration** — connect a Zap in Settings and Converse360 pushes
  events to it (with a "send test" button), so non-developers can wire it to
  the other tools they already use without writing a webhook receiver.
- **Rate limiting per key**, and a stable error-code contract so your
  integration can branch on `error.code` rather than parsing English.
- Full reference: [`docs/public-api.md`](../public-api.md).

---

## 15. Plans

Three plans — **Starter, Growth, Enterprise** — read live from the database,
so pricing changes need no deploy. Prices are in **INR**.

| | Starter | Growth | Enterprise |
| --- | --- | --- | --- |
| Contacts | 1,000 | 10,000 | Unlimited |
| Messages / month | 5,000 | 50,000 | Unlimited |
| Broadcasts / month | 25 | 100 | Unlimited |
| Flows | 10 | Unlimited | Unlimited |
| Team members | 3 | 10 | Unlimited |
| Support | Priority | Priority + advanced analytics | Dedicated AM, custom SLA, onboarding & migration |

> ⚠️ **Sales note:** these are the *seeded* limits. The live table is the
> authority and an operator may have changed them — check the pricing page
> before quoting. Enterprise is **quoted, not listed**: its listed price is
> zero because it's negotiated, and enquiries are captured as a sales signal.

- **A 15-day trial, once per workspace.** Selecting a plan in the welcome
  wizard starts it — no card, no payment. Clicking between plans carries the
  same clock forward; it does not mint a fresh 15 days.
- **Payments via Stripe and Razorpay** (Razorpay for India).
- **Plan limits are enforced** — contacts, messages, broadcasts, flows and
  team members are checked against your plan, with monthly usage counted per
  workspace.

---

## Positioning — what to lead with

Ranked by how hard they are for a competitor to copy:

1. **One contact across WhatsApp, Instagram and web.** Not three inboxes with
   a shared logo. This is architectural and most competitors can't retrofit it.
2. **An AI agent you configure, not a chatbot you pray at.** Persona, ground
   rules, your documents, switchable skills, your own API as a tool — and a
   test surface that is genuinely production.
3. **The AI knows when to shut up.** A human replies and the bot pauses, on
   that thread, automatically. Every demo audience feels this one.
4. **250 free AI credits, no key, no config.** Time-to-value is minutes.
5. **Broadcasts that survive reality** — queued, retried, resumed after a
   restart, with per-recipient delivery status.
6. **Segments as first-class audiences**, static or self-updating, and six
   places that can file someone into one.
7. **Official Meta API throughout.** Your number, your templates, your quality
   rating — no ban risk from unofficial libraries.
8. **A real API and Zapier**, so it's a platform, not a silo.

### Honest limits, so sales doesn't oversell

- **WhatsApp templates are Meta's rules, not ours.** Marketing messages
  outside the 24-hour window need an approved template, and approval is Meta's
  call. Set this expectation at demo time.
- **Voice/phone is not available.** It's on the roadmap; it's not sold.
- **Ads Manager is not switched on yet** — see the [roadmap](roadmap.md).
- **Website visitors can't be broadcast to.** There's no way to push to a
  browser tab that's closed. WhatsApp and Instagram carry re-engagement.
- **AI credits and message quotas are different meters.** Credits pay for AI
  thinking; plan limits cap messages. A customer can exhaust one and not the
  other.

---

*Maintained alongside the codebase. If a claim here stops being true, fix it
here in the same change — this file gets quoted verbatim on public pages.*
