# NestJS Migration Tracking: Phase 3 (Public API V1)

This document tracks the completed migration of the Public API V1 from Next.js route handlers to the NestJS backend architecture (`apps/api`).

## Summary of Accomplishments

All 11 legacy public API routes (comprising 16 distinct HTTP method handlers) have been successfully ported, registered, typed, and integrated under the new NestJS backend. The legacy route files have been cleaned up, and Next.js has been configured to reverse-proxy all incoming public API requests.

---

## 1. Migrated Endpoints & Contracts

The new `V1Module` manages the `/v1` prefix and handles authorization scopes using the global `ApiKeyGuard`.

| Endpoint | Method | Required Scope | Controller & Method |
| :--- | :--- | :--- | :--- |
| `/v1/me` | `GET` | *None (Requires Valid Key)* | `MeController.getMe` |
| `/v1/contacts` | `GET` | `contacts:read` | `ContactsController.listContacts` |
| `/v1/contacts` | `POST` | `contacts:write` | `ContactsController.createContact` |
| `/v1/contacts/:id` | `GET` | `contacts:read` | `ContactsController.getContact` |
| `/v1/contacts/:id` | `PATCH` | `contacts:write` | `ContactsController.updateContact` |
| `/v1/conversations` | `GET` | `conversations:read` | `ConversationsController.listConversations` |
| `/v1/conversations/:id` | `GET` | `conversations:read` | `ConversationsController.getConversation` |
| `/v1/conversations/:id/messages` | `GET` | `messages:read` | `ConversationsController.listMessages` |
| `/v1/messages` | `POST` | `messages:send` | `MessagesController.sendMessage` |
| `/v1/broadcasts` | `POST` | `broadcasts:send` | `BroadcastsController.createBroadcast` |
| `/v1/broadcasts/:id` | `GET` | `broadcasts:send` | `BroadcastsController.getBroadcast` |
| `/v1/webhooks` | `GET` | `webhooks:manage` | `WebhooksController.listWebhooks` |
| `/v1/webhooks` | `POST` | `webhooks:manage` | `WebhooksController.createWebhook` |
| `/v1/webhooks/:id` | `GET` | `webhooks:manage` | `WebhooksController.getWebhook` |
| `/v1/webhooks/:id` | `PATCH` | `webhooks:manage` | `WebhooksController.updateWebhook` |
| `/v1/webhooks/:id` | `DELETE` | `webhooks:manage` | `WebhooksController.deleteWebhook` |

---

## 2. Infrastructure & Utility Modules Ported

To support the endpoints, the following core packages and services were built:

*   **`respond.util.ts`**: Implemented type-safe standard error responses and list wrappers matching the legacy public API schema.
*   **`pagination.util.ts`**: Ported the opaque base64 Keyset pagination cursors (`encodeCursor`/`decodeCursor`) ensuring parity for paginated responses.
*   **`webhook-sign.util.ts`**: Implemented signature validation and webhook hash verification.
*   **`webhook-deliver.service.ts`**: Created the outgoing event dispatcher, featuring SSRF prevention checks, retry logic with exponential backoff, and logging/recording of event failures.
*   **`webhooks.util.ts`**: Standardized webhook creation validation, HTTPS URL checks, and secret formatting (`whsec_...`).

---

## 3. Configuration & Routing Integration

*   **Module Registration**: Created `V1Module` and wired it into `AppModule` (`apps/api/src/app.module.ts`).
*   **Rate Limits**: Replaced the placeholder rate-limit configuration in `ApiKeyGuard` with the official `PUBLIC_API_RATE_LIMIT` budget (120 req/60s).
*   **Reverse Proxy Config**: Added a `beforeFiles` rewrite rule in `apps/web/next.config.ts` mapping `/api/v1/:path*` requests to `${NEST_API_URL}/v1/:path*`.
*   **Legacy Cleanup**: Removed the now redundant `apps/web/src/app/api/v1/` directory.

---

## 4. Verification

*   Run `npm run typecheck` inside `apps/api`: **Passed with 0 errors**.
*   Run `npm run test` inside `apps/api`: **Passed 186/186 tests successfully**.
