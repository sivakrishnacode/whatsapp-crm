# Implementation Plan - Phase 4: WhatsApp Domain Migration

The goal of this phase is to migrate the remaining WhatsApp domain logic, endpoints, and background handlers from Next.js (`apps/web/src/app/api/whatsapp/`) to the NestJS backend (`apps/api/src/whatsapp/`). This includes the 1,180+ line Meta webhook receiver, media passthrough proxying, embedded signup integration, order/product mock mappings, and dashboard-specific message/broadcast endpoints.

## User Review Required

> [!IMPORTANT]
> **Webhook Async Execution (`after()` replacement):** The Next.js webhook receiver used Vercel-specific `after()` calls to respond with `200 OK` to Meta immediately while performing database updates and event dispatches asynchronously. Since NestJS runs as a persistent service, we will replace `after()` with non-blocking fire-and-forget asynchronous calls (e.g. executing tasks in background microtasks via standard async/promise execution or enqueuing to local Event Emitters). This avoids serverless execution freeze while keeping Meta webhook response latency under 500ms.
>
> **Lead Ads Webhook Security:** During migration, we propose checking the signature of incoming Facebook Lead Ads webhook events using the same signature verification machinery (`verifyMetaWebhookSignature`) to prevent spoofing, addressing a security gap identified in the legacy codebase.

## Proposed Changes

We will introduce a cohesive `WhatsappModule` (updating `apps/api/src/whatsapp/whatsapp.module.ts`) and port the remaining route handlers into NestJS controllers and services.

---

### 1. Common / Shared Relocations

#### [NEW] [encryption.util.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/common/security/encryption.util.ts)
Relocate the general encryption utilities from `src/whatsapp/encryption.util.ts` to `src/common/security/encryption.util.ts` so they can be shared globally by all modules (AI configurations, webhook secrets, and WhatsApp connection credentials).

---

### 2. Services & Utilities

#### [NEW] [connect-account.service.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/services/connect-account.service.ts)
Port `connect-account.ts` logic into a service to manage Meta signup connections:
* Verify phone number ID configuration.
* Exchange embedded sign-up tokens.
* Validate access tokens and register phone numbers with Meta.
* Subscribe the WhatsApp Business Account (WABA) to the CRM application.
* Persist details in the `whatsapp_config` table.

#### [NEW] [webhook-signature.util.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/utils/webhook-signature.util.ts)
Port signature validation `verifyMetaWebhookSignature()` (validating the SHA256 HMAC payload over the raw body against the configured `META_APP_SECRET`).

---

### 3. Controllers & Routes

We will establish controllers in `apps/api/src/whatsapp/controllers/` to handle all incoming dashboard and Meta integration routes.

#### [NEW] [whatsapp-webhook.controller.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/controllers/whatsapp-webhook.controller.ts)
Port the main Meta Webhook handler (`apps/web/src/app/api/whatsapp/webhook/route.ts`):
* `GET`: Verification handshake. Loops through configuration records, decrypts verify tokens, and responds to Meta's ping.
* `POST`: Incoming event processing. Handles status update progression, message/reaction storage, contact/conversation matching, and background dispatch to Automations/Flows/AI modules.

#### [NEW] [whatsapp-connect.controller.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/controllers/whatsapp-connect.controller.ts)
Manage connection settings and setup modes:
* `POST /whatsapp/connect`: Embedded Signup completion.
* `GET/POST/DELETE /whatsapp/config`: Setup status, diagnostics, and resetting configuration data.
* `GET /whatsapp/config/verify-registration`: Run diagnostic checks (token expiry, sandbox status).

#### [NEW] [whatsapp-templates.controller.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/controllers/whatsapp-templates.controller.ts)
Manage message templates synced from Meta:
* `POST /whatsapp/templates/sync`: Trigger a paginated fetch and local DB upsert of Meta templates.
* `POST /whatsapp/templates/submit`: Submit a new template draft to Meta for review.
* `PATCH/DELETE /whatsapp/templates/:id`: Edit or delete local/remote templates.

#### [NEW] [whatsapp-media.controller.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/controllers/whatsapp-media.controller.ts)
* `GET /whatsapp/media/:mediaId`: Secure media pass-through proxy. Resolves short-lived Meta CDN URLs and streams image/video content without local disk storage.

#### [NEW] [whatsapp-dashboard.controller.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/api/src/whatsapp/controllers/whatsapp-dashboard.controller.ts)
Handles standard agent messaging actions:
* `POST /whatsapp/send`: Individual text/media/template send from Inbox.
* `POST /whatsapp/broadcast`: Quick/Standard campaign dispatches.
* `POST /whatsapp/react`: Send reaction status to messages.

---

### 4. Integration & Routing Config

#### [MODIFY] [next.config.ts](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/web/next.config.ts)
Add the rewrite mapping to `beforeFiles`:
```typescript
{ source: "/api/whatsapp/:path*", destination: `${nestApiUrl}/whatsapp/:path*` }
```

#### [DELETE] [Legacy Directory](file:///home/sivakrishna/Desktop/Projects/wacrm/apps/web/src/app/api/whatsapp)
Delete the legacy Next.js webhook and api routes directory after verifying integration.

---

## Verification Plan

### Automated Tests
* Port the suite of Vitest test files to `apps/api` and execute:
  `npm run test`
* Run `npm run typecheck` to verify complete type safety.

### Manual Verification
1. **Handshake Test**: Query the `GET /api/whatsapp/webhook` verification endpoint and verify a valid response.
2. **Inbound Pipeline Test**: Mock an incoming WhatsApp Webhook payload and verify that it resolves/creates contacts, updates the chat inbox, and triggers automations correctly.
3. **Onboarding Test**: Run setup diagnostics to confirm configuration decryption.
