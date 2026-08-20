# Screencast 1 · WhatsApp — voiceover script

Narration for the App Review screencast supporting **submission 1**
(`whatsapp_business_management`, `whatsapp_business_messaging`,
`business_management`). Companion to [meta-app-review.md](meta-app-review.md).

| | |
|---|---|
| Source recording | `converse360-sample.mp4` |
| Duration | **2:56** (175.8s) |
| Resolution | 1280×720, 30fps |
| Existing audio | Silent (−91 dB) — drop the voiceover straight in, nothing to strip |
| Narration length | ~400 words, paced for ~140 wpm with pauses |

---

## ⚠️ Read this before editing

**Overlay the phone footage as picture-in-picture. Do not cut away to it.**

Meta's most common rejection reason is a partial or edited video. Compositing
a second source *on top of* the screen recording leaves the screen recording
continuous and full-length, which is what they check. **Inserting** phone
segments into the timeline — cutting from screen, to phone, back to screen —
lengthens the video and breaks that continuity.

So:

- ✅ Phone footage in a corner, base recording untouched underneath
- ✅ Adding an audio track, captions, a highlight ring around the cursor
- ❌ Cutting away to full-screen phone footage
- ❌ Trimming dead air, speeding up loading spinners, splicing takes

Keep the base video at exactly 2:56 with no cuts, and every timecode below
stays valid.

---

## What is on screen

| Time | Screen | Permission it evidences |
|---|---|---|
| 0:00 | Login page, sign in | — |
| 0:24 | WhatsApp → Channel Settings | — |
| 0:36 | Facebook Login for Business opens | — |
| 0:42 | "Select the business assets to share with Converse 360" | `business_management` |
| 0:48 | "Add your WhatsApp phone number" | — |
| **0:54** | **"Review what you'll share" — full permission list + Confirm** | **all three** |
| 1:12 | SMS confirmation code | — |
| 1:36 | "Your account is connected to Conceps" + **Add payment method** | Tech Provider model |
| 1:48 | Connected card — GREEN, phone number ID, WABA ID | `whatsapp_business_management` |
| 2:00 | Templates — 2 authored, status Pending | `whatsapp_business_management` |
| 2:12 | Test Workspace inbox | — |
| 2:24 | Conversation open, agent typing | `whatsapp_business_messaging` |
| 2:36 | Reply delivered | `whatsapp_business_messaging` |
| 2:48 | Settings → Users & Roles | shared-inbox claim |

The frame at **0:54** is the most important in the video — the consent screen
with the permission list, the Privacy Policy and Terms links, and the Confirm
button. Most rejected submissions never show it. Do not crop or cover it with
the phone overlay.

---

## Where the phone footage goes

Only one window needs it: **2:10 → 2:48**, the messaging section.

Sync so that:

- the customer's inbound message (**16:39** in the thread) appears on the phone
  a beat *before* it lands in the inbox;
- the agent's reply (**16:40**, "hello from converse360") appears on the phone
  a beat *after* it is sent on screen.

That ordering is the whole point — it proves a real round trip rather than two
unrelated recordings. Park the overlay bottom-right, away from the message
thread and the workspace switcher.

Outside 2:10–2:48, leave the frame clean.

---

## The script

Each block is timed to the base recording. Generate them as separate clips and
place them on the timeline — easier to nudge than one continuous read.

### [0:00 – 0:12] · Sign-in

> This is Converse360, a WhatsApp CRM and shared team inbox. A business signs
> in to its own workspace.

### [0:12 – 0:24] · Dashboard

> Every business connects its own WhatsApp Business Account through Meta's
> Embedded Signup. We never message from a number we own.

### [0:24 – 0:36] · Channel Settings

> From Channel Settings, the business starts the connection itself.

### [0:36 – 0:48] · Asset selection

> Facebook Login for Business opens. The business selects which business
> portfolio and which WhatsApp Business Account to share with us. We list only
> the assets they already own, reading names and IDs. This is what we use
> business management for.

### [0:48 – 0:54] · Phone number

> Next, they choose the phone number they want to send from.

### [0:54 – 1:10] · Consent screen ⭐

> This is the consent screen. Converse360 is requesting access to manage their
> WhatsApp accounts, to access conversations in WhatsApp, and to log events on
> their behalf. Our Privacy Policy and Terms are linked here. Nothing is
> granted until the business confirms.

### [1:10 – 1:24] · Verification

> Meta sends a confirmation code to the number, and the business verifies it.

### [1:24 – 1:36] · Onboarding

> Meta completes onboarding.

### [1:36 – 1:50] · Payment method ⭐

> The account is connected. Note the payment method step. We operate as a Tech
> Provider: each business adds its own payment method to its own WhatsApp
> Business Account, and Meta bills them directly. We never hold a line of
> credit and never resell conversations.

### [1:50 – 2:02] · Connected card

> Back in the product, the credentials are saved and verified. We register the
> number for Cloud API, subscribe our app so their inbound messages reach this
> inbox, and read the display name and quality rating shown here. That is
> whatsapp business management.

### [2:02 – 2:10] · Templates

> The same permission submits the message templates the business authors here,
> and reads their approval status back from Meta.

### [2:10 – 2:22] · Workspace switch ⭐

> Switching to a second workspace. This one is connected to Meta's test number,
> because our app is awaiting Advanced Access on whatsapp business messaging —
> the permission this submission requests.

### [2:22 – 2:38] · Inbox and reply

> Inbound customer messages arrive on our webhook and appear in the shared
> inbox. An agent replies in plain text, inside WhatsApp's twenty-four hour
> customer service window. Outside that window, our composer requires an
> approved template instead.

### [2:38 – 2:48] · Delivered

> The reply is delivered. That is whatsapp business messaging — every send is
> on behalf of the business that owns the number, triggered by a signed-in team
> member.

### [2:48 – 2:56] · Team

> And the inbox is shared. Several team members answer one number from one
> place.

---

## Continuous version

For a single TTS render. Insert a 1-second pause at each paragraph break, then
stretch or nudge to fit.

```
This is Converse360, a WhatsApp CRM and shared team inbox. A business signs in to its own workspace.

Every business connects its own WhatsApp Business Account through Meta's Embedded Signup. We never message from a number we own.

From Channel Settings, the business starts the connection itself.

Facebook Login for Business opens. The business selects which business portfolio and which WhatsApp Business Account to share with us. We list only the assets they already own, reading names and IDs. This is what we use business management for.

Next, they choose the phone number they want to send from.

This is the consent screen. Converse360 is requesting access to manage their WhatsApp accounts, to access conversations in WhatsApp, and to log events on their behalf. Our Privacy Policy and Terms are linked here. Nothing is granted until the business confirms.

Meta sends a confirmation code to the number, and the business verifies it.

Meta completes onboarding.

The account is connected. Note the payment method step. We operate as a Tech Provider: each business adds its own payment method to its own WhatsApp Business Account, and Meta bills them directly. We never hold a line of credit and never resell conversations.

Back in the product, the credentials are saved and verified. We register the number for Cloud API, subscribe our app so their inbound messages reach this inbox, and read the display name and quality rating shown here. That is whatsapp business management.

The same permission submits the message templates the business authors here, and reads their approval status back from Meta.

Switching to a second workspace. This one is connected to Meta's test number, because our app is awaiting Advanced Access on whatsapp business messaging — the permission this submission requests.

Inbound customer messages arrive on our webhook and appear in the shared inbox. An agent replies in plain text, inside WhatsApp's twenty-four hour customer service window. Outside that window, our composer requires an approved template instead.

The reply is delivered. That is whatsapp business messaging — every send is on behalf of the business that owns the number, triggered by a signed-in team member.

And the inbox is shared. Several team members answer one number from one place.
```

---

## Captions

**Burn these in.** Reviewers frequently watch muted, and Meta accepts on-screen
text in place of narration — so captions are the half that always lands. If you
only do one of the two, do captions.

Use the script verbatim as the subtitle track. Two lines maximum on screen,
bottom-centre, and **not** in the bottom-right corner where the phone overlay
sits between 2:10 and 2:48.

---

## Voice settings

- **Flat and factual.** No music, no enthusiasm, no brand voice. A reviewer is
  scanning for evidence, and anything that reads as marketing works against you.
- **Say permission names as words** — "whatsapp business messaging", not spelled
  out letter by letter and not "whatsapp underscore business underscore
  messaging".
- **English**, clear and unhurried. ~140 words per minute.
- Leave the gaps. The script is deliberately short of the full 2:56; silence
  over a loading spinner is better than filler.

---

## Before uploading

- [ ] Base video still exactly 2:56, no cuts, no speed changes
- [ ] Phone overlay only between 2:10 and 2:48, bottom-right
- [ ] Consent screen at 0:54 fully visible and uncovered
- [ ] Captions burned in, not covering the phone overlay
- [ ] Narration matches what is on screen at every timecode
- [ ] Exported at 1280×720 or higher, under Meta's size limit
- [ ] Uploaded to **all three** permission cards — one file, three attachments

---

## Known gaps in this take

Neither is fatal; both are worth knowing in case a reviewer comes back.

- **The 24-hour window refusal is narrated but not shown.** The script mentions
  it at 2:22; the recording never demonstrates the composer refusing free text.
  Showing it is stronger than saying it.
- **The inbound message is not filmed arriving** in the base recording — the
  phone overlay is what supplies that. If the overlay is dropped, the thread
  history still evidences inbound customer messages, but weakly.
