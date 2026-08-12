# Converse360 — Roadmap

> **Audience:** marketing, sales and support. The companion to
> [features.md](features.md), which covers only what ships today.
>
> Everything here is **not yet sellable**. The distinction matters: one of
> these is code-complete and waiting on Meta's approval, one is a design
> decision we have deliberately not made, and one is a genuine "not built".
> Confusing them is how a demo becomes a refund.
>
> Last verified against the codebase: **12 August 2026**.

---

## How to read the status column

| Status | What it means | May sales say it? |
| --- | --- | --- |
| 🟩 **Ready — gated** | Built, tested, running behind a switch. Waiting on an external approval or a go-live decision | Only as "coming, in private preview" — **never** with a date |
| 🟨 **In build** | Actively being worked on. Shape is settled, not finished | Mention as direction only. No commitments |
| 🟦 **Planned** | Decided, specified, not started | "On the roadmap." Nothing more |
| ⬜ **Considering** | An idea with a real reason behind it, not yet committed | Do not mention |
| ⛔ **Deliberately not doing** | We looked at it and said no. Know the reason — it's usually a good story | Explain the reasoning if asked |

**The rule:** never give a customer a date for anything on this page. If a
deal genuinely depends on one, escalate — don't guess.

---

## 1. Meta Ads Manager 🟩 Ready — gated

**The biggest thing in the pipeline, and it is finished.**

Run your Meta advertising from inside Converse360, with the ad spend
attributed all the way through to the conversation and the deal it produced.

**What's built:**

- Connect your Meta ad account by a secure server-side login.
- A **four-step publish wizard** — objective, audience, creative, budget.
- **Five ad types**, including **Click-to-WhatsApp** ads that drop the customer
  straight into your inbox.
- **Meta lead forms** — instant forms whose leads become contacts.
- **Audiences** built from your own conversation and contact data.
- **Insights sync** — spend, reach, CPC, CPM pulled back on a schedule.
- **Spend → deal attribution.** The number nobody else in this category can
  show a customer: what an ad actually earned, not what it reached.
- Reach estimates and previews before you spend anything.

**Why it isn't switched on:** it needs Meta's **App Review** for the
`ads_management` permission. That's Meta's queue, not our backlog, and there is
no date to give.

**Sales guidance:** this is the strongest "where we're going" story in the
product — spend attributed to revenue in the same tool as the conversation.
Show it as direction. **Do not** promise it in a contract, and don't imply it's
weeks away.

---

## 2. Voice channel 🟦 Planned {#voice-channel}

The fourth channel. The product's channel architecture already treats platforms
as pluggable — WhatsApp, Instagram and web all plug into one shared contact and
conversation model, and Phone is registered as a locked, "coming soon" slot in
that same list.

**What has to exist before it's real:** a configuration surface of its own and
a working inbound path. Neither is built.

**Sales guidance:** "on the roadmap." It appears in the product as a greyed-out
row with a *Coming soon* label, so prospects will ask. Answer honestly — it's a
planned channel, not a hidden one.

---

## 3. WhatsApp capabilities not yet implemented

Converse360 implements a subset of Meta's WhatsApp Cloud API. These are the
gaps, and roughly the order they're worth closing.

| Capability | Status | Why a customer would want it |
| --- | --- | --- |
| **Typing indicators & mark-as-read (outbound)** | 🟦 Planned | The customer sees "typing…" while an agent or the AI composes. Read receipts are already *received*; we just don't *send* them yet. Small change, disproportionate perceived quality |
| **WhatsApp Payments** (order & payment messages, IN/SG) | 🟦 Planned | Take the money inside the chat. Genuinely transformative for the D2C segment, and the largest of these items by far |
| **QR codes / short links** | ⬜ Considering | Printable "message us" codes for packaging, receipts and shopfronts |
| **Commerce settings** | ⬜ Considering | Control the catalogue and cart experience from our dashboard rather than Meta's |
| **Block users** | ⬜ Considering | Block an abusive number at the platform level, not just close the thread |
| **WhatsApp analytics API** | ⬜ Considering | Meta's own conversation and message analytics alongside ours |
| **Business compliance info** | ⬜ Considering | Required for some regulated categories in some markets |

**Sales guidance:** don't volunteer this list. If a prospect asks for payments
in chat specifically, it's "planned, not available" — and it's worth logging as
a demand signal, because it's the one on this list that closes deals.

---

## 4. Flows: `collect_form` node 🟦 Planned

Today a flow can **send** a form and carry on. The planned node **blocks the
flow until the form comes back**, then continues with the answers available to
later steps.

The difference matters for anything with a real qualification gate: "collect
these five fields, *then* route to a salesperson" is one node instead of a
workaround.

Deferred because it needs a new resume path in the flow engine — worth doing
properly rather than bolted onto the existing sweep.

---

## 5. Enterprise pricing & revenue reporting 🟨 In build

Enterprise is sold at a negotiated price. Because plan pricing is a property of
the plan rather than of each customer, a negotiated Enterprise contract
currently **contributes nothing to reported revenue** — the enquiry and the
agreed number live outside the billing tables.

**Today's workaround** (and it works): create a private plan row per Enterprise
customer with their real price, marked inactive so nobody else is ever offered
it, and assign it to that workspace.

**What's coming:** per-subscription pricing, so a negotiated deal is a first-
class fact rather than a private plan and a convention.

**Sales guidance:** internal only. Never discuss with a customer. But **do**
follow the workaround for every Enterprise close, or that customer is invisible
in revenue reporting.

---

## 6. Reporting depth ⬜ Considering

Today's reporting is exact for **right now** — MRR, ARR, pipeline, conversation
volume, ad spend. What it can't do is show you **history**: because revenue is
derived from current plan prices rather than recorded per transaction, changing
a price rewrites the past.

A payments/invoice ledger would fix it. It's a real gap for anyone who wants
year-on-year revenue reporting, and it's honest to say so.

**Already exact and historical:** AI credits. Every credit that moved is
recorded, and every top-up records what was actually charged — so credit
consumption and credit revenue can be trended properly today.

---

## 7. Deliberately not doing ⛔

These come up in competitive comparisons. The reasoning is the answer.

### Web broadcasts

You cannot push a message to a browser tab that's been closed. A "web
broadcast" feature would be a queue of messages nobody receives.
**Re-engagement is what WhatsApp and Instagram are for** — that's the point of
having one contact across three channels.

### Guessing that two contacts are the same person

A WhatsApp number and an Instagram handle are merged when the customer
**tells** us they're the same person — never by inference. Guessing wrong means
showing one customer another customer's conversation. We chose the version that
can't do that.

### A separate Appointments product

Booking **is** a form — one carrying a slot picker. A standalone appointments
module meant two field systems, two submission paths and two things to keep in
step. Bookings therefore live inside Forms, and get every form capability for
free (automation triggers, contact linking, hosted pages).

### Ad credits / buying ad spend through us

Ads run on the **customer's** ad account and Meta bills them directly. There is
no wallet, no markup and no money through us. Competitors who add a "Buy
Credits" button become an unlicensed payment processor for someone else's ad
spend; the honest equivalent is showing whether the customer's own funding is
in order, which is what we do.

### Reintroducing a free plan

There is no free tier. It was retired deliberately — a free tier with no
support path and no conversion pressure costs more to run than it earns, and
there's nowhere to downgrade *to* when someone cancels. The **15-day trial** is
the try-before-you-buy path, and it's once per workspace.

---

## Quick reference — what sales may say

| Prospect asks | Answer |
| --- | --- |
| "Can I run my Meta ads from here?" | "It's built and in private preview, pending Meta's approval — I can show you. I can't give you a date." |
| "Do you do voice / calling?" | "Not today. It's a planned channel." |
| "Can customers pay inside WhatsApp?" | "Not yet — it's on the roadmap. Today we send the order and the payment link." |
| "Can I broadcast to website visitors?" | "No, and no one can — a closed tab can't receive a message. That's what the WhatsApp channel is for." |
| "Is there a free plan?" | "No. There's a 15-day full trial, no card needed." |
| "Will the AI show as typing?" | "Not yet. It's a planned improvement." |
| "Can I see revenue for last year?" | "Current revenue and pipeline, yes, exactly. Historical revenue reporting is being built." |

---

*Keep this file in step with reality. An item that ships moves to
[features.md](features.md) in the same change — a roadmap that still lists
shipped features is how a sales team ends up under-selling the product.*
