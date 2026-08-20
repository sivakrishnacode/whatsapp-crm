# Screencast 1 · WhatsApp — voiceover script

Narration for the App Review screencast supporting **submission 1**
(`whatsapp_business_management`, `whatsapp_business_messaging`,
`business_management`). Companion to [meta-app-review.md](meta-app-review.md).

| | |
|---|---|
| Source recording | `converse360-sample.mp4` (2:56, 1280×720, 30fps) |
| **Final cut** | **2:53** |
| Phone footage enters | **2:11** |
| Existing audio | Silent (−91 dB) — drop the voiceover straight in, nothing to strip |
| Narration | ~340 words over 2:53, paced for ~140 wpm |

---

## ⚠️ Two editing rules

**1. Overlay the phone footage. Do not cut away to it.**

Meta's most common rejection reason is a partial or edited video. Compositing a
second source *on top of* the screen recording leaves the screen recording
continuous, which is what they check. Cutting from screen, to phone, back to
screen breaks that.

- ✅ Phone in a corner, base recording running untouched underneath
- ✅ Audio track, burned-in captions, cursor highlight
- ❌ Full-screen cutaway to the phone
- ❌ Trimming dead air or speeding up loading spinners *inside* the recording

**2. Where those 3 seconds came from matters.**

2:56 → 2:53. Trimming the very start (before sign-in) or the very tail (after
the last action) is normal and fine. Cutting 3 seconds out of the *middle* — a
spinner, a pause — is exactly the edit that gets a submission rejected as
partial. If the trim came from the middle, put it back and lose the 3 seconds
off the ends instead.

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
| 2:02 | Templates — 2 authored, status Pending | `whatsapp_business_management` |
| **2:11** | **Workspace switch — phone overlay enters** | — |
| 2:22 | Conversation, agent replies | `whatsapp_business_messaging` |
| 2:38 | Reply delivered | `whatsapp_business_messaging` |
| 2:48 | Settings → Users & Roles | shared-inbox claim |

The frame at **0:54** is the most important in the video — the consent screen
with the permission list, the Privacy Policy and Terms links, and the Confirm
button. Most rejected submissions never show it. Nothing may cover it.

---

## The phone overlay: 2:11 → 2:53

Sync so that:

- the customer's inbound message (**16:39** in the thread) appears on the phone
  a beat *before* it lands in the inbox;
- the agent's reply (**16:40**, "hello from converse360") appears on the phone
  a beat *after* it is sent on screen.

That ordering is the point — it proves a real round trip rather than two
unrelated recordings. Park it **bottom-right**, clear of the message thread and
the workspace switcher. Before 2:11, leave the frame clean.

---

## The script

Timed to the 2:53 cut. Generate each block as its own clip and place it — far
easier to nudge than one continuous read. Word counts are the ceiling at
140 wpm; every block is deliberately under, because silence over a spinner
beats filler.

### [0:00 – 0:12] · Sign-in

> This is Converse360, a WhatsApp CRM and shared team inbox. A business signs
> in to its own workspace.

### [0:12 – 0:24] · Dashboard

> Every business connects its own WhatsApp Business Account through Meta's
> Embedded Signup. We never message from a number we own.

### [0:24 – 0:36] · Channel Settings

> From Channel Settings, the business starts the connection itself.

### [0:36 – 0:48] · Asset selection

> Facebook Login for Business opens. The business selects which portfolio and
> which WhatsApp Business Account to share with us — names and IDs only. That
> is what we use business management for.

### [0:48 – 0:54] · Phone number

> Next, they choose the phone number they want to send from.

### [0:54 – 1:10] · Consent screen ⭐

> This is the consent screen. Converse360 is requesting access to manage their
> WhatsApp accounts, to access conversations, and to log events on their
> behalf. Our Privacy Policy and Terms are linked here. Nothing is granted
> until the business confirms.

### [1:10 – 1:24] · Verification

> Meta sends a confirmation code to the number, and the business verifies it.

### [1:24 – 1:36] · Onboarding

> Meta completes onboarding.

### [1:36 – 1:50] · Payment method ⭐

> The account is connected. Note the payment method step: we operate as a Tech
> Provider. Each business adds its own payment method to its own WhatsApp
> Business Account, and Meta bills them directly — we never hold credit or
> resell conversations.

### [1:50 – 2:02] · Connected card

> Credentials saved and verified. We register the number for Cloud API,
> subscribe our app so inbound messages reach this inbox, and read the display
> name and quality rating shown here — whatsapp business management.

### [2:02 – 2:11] · Templates

> The same permission submits the message templates the business authors here,
> and reads their approval status back from Meta.

### [2:11 – 2:22] · Workspace switch ⭐ *(phone overlay enters)*

> Switching to a second workspace, connected to Meta's test number — our app is
> awaiting Advanced Access on whatsapp business messaging, the permission this
> submission requests.

### [2:22 – 2:38] · Inbox and reply

> Inbound customer messages arrive on our webhook and appear in the shared
> inbox. An agent replies in plain text, inside WhatsApp's twenty-four hour
> customer service window. Outside it, our composer requires an approved
> template.

### [2:38 – 2:48] · Delivered

> Delivered. That is whatsapp business messaging — every send is on behalf of
> the business that owns the number, triggered by a signed-in team member.

### [2:48 – 2:53] · Team

> And the inbox is shared — several teammates answer one number together.

---

## Continuous version

For a single TTS render. One-second pause at each paragraph break, then nudge
to fit.

```
This is Converse360, a WhatsApp CRM and shared team inbox. A business signs in to its own workspace.

Every business connects its own WhatsApp Business Account through Meta's Embedded Signup. We never message from a number we own.

From Channel Settings, the business starts the connection itself.

Facebook Login for Business opens. The business selects which portfolio and which WhatsApp Business Account to share with us — names and IDs only. That is what we use business management for.

Next, they choose the phone number they want to send from.

This is the consent screen. Converse360 is requesting access to manage their WhatsApp accounts, to access conversations, and to log events on their behalf. Our Privacy Policy and Terms are linked here. Nothing is granted until the business confirms.

Meta sends a confirmation code to the number, and the business verifies it.

Meta completes onboarding.

The account is connected. Note the payment method step: we operate as a Tech Provider. Each business adds its own payment method to its own WhatsApp Business Account, and Meta bills them directly — we never hold credit or resell conversations.

Credentials saved and verified. We register the number for Cloud API, subscribe our app so inbound messages reach this inbox, and read the display name and quality rating shown here — whatsapp business management.

The same permission submits the message templates the business authors here, and reads their approval status back from Meta.

Switching to a second workspace, connected to Meta's test number — our app is awaiting Advanced Access on whatsapp business messaging, the permission this submission requests.

Inbound customer messages arrive on our webhook and appear in the shared inbox. An agent replies in plain text, inside WhatsApp's twenty-four hour customer service window. Outside it, our composer requires an approved template.

Delivered. That is whatsapp business messaging — every send is on behalf of the business that owns the number, triggered by a signed-in team member.

And the inbox is shared — several teammates answer one number together.
```

---

## Captions

**Burn these in.** Reviewers frequently watch muted, and Meta accepts on-screen
text in place of narration — so captions are the half that always lands. If you
only do one of the two, do captions.

Script verbatim, two lines maximum, bottom-**centre** — and **not** bottom-right
between 2:11 and 2:53, where the phone overlay sits.

---

## Voice settings

- **Flat and factual.** No music, no enthusiasm, no brand voice. A reviewer is
  scanning for evidence; anything that reads as marketing works against you.
- **Say permission names as words** — "whatsapp business messaging", never
  spelled out and never "underscore".
- **English**, clear and unhurried, ~140 wpm.
- Leave the gaps. ~340 words across 173 seconds is intentional.

---

## Before uploading

- [ ] Final cut is 2:53, with the 3 trimmed seconds taken off the ends, not the middle
- [ ] No speed changes, no spliced takes
- [ ] Phone overlay only from 2:11, bottom-right
- [ ] Consent screen at 0:54 fully visible and uncovered
- [ ] Captions burned in, bottom-centre, not colliding with the overlay
- [ ] Narration matches what is on screen at every timecode
- [ ] Exported at 1280×720 or higher, under Meta's size limit
- [ ] Uploaded to **all three** permission cards — one file, three attachments

---

## Known gap in this take

**The 24-hour window refusal is narrated but not shown.** The script states it
at 2:22; the recording never demonstrates the composer refusing free text.
Showing it is stronger than saying it — worth a re-take if one is cheap, not
worth blocking the submission over.
