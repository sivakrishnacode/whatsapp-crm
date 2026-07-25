# WhatsApp Native Commerce — Phased Implementation Plan

## Background

The codebase already has a solid commerce foundation:
- **`043_whatsapp_native_commerce.sql`** — `whatsapp_products` and `whatsapp_orders` tables exist with RLS.
- **`whatsapp-shop.controller.ts`** — Full CRUD for products + orders, `POST /products/sync` (push to Meta) and `POST /products/import` (pull from Meta) are live.
- **`meta-api.util.ts`** — `sendProductMessage`, `sendProductListMessage`, `syncCatalogItems`, `fetchCatalogProducts`, `deleteCatalogItems`, `getCatalogBatchStatus` are already implemented.
- **`whatsapp-webhook.service.ts`** — `order` message type is already parsed and a `whatsapp_orders` record is created on receipt.
- **`flow.types.ts`** — Flow node type system (discriminated union) is the extension point for a new `send_product` node type.

This plan fills the remaining **gaps** without re-implementing what exists.

---

## Open Questions

> [!IMPORTANT]
> Please answer these before starting Phase 1.

1. **Shopify sync direction authority** — When a product exists in both `whatsapp_products` and `ecommerce_products`, which is source-of-truth on price/stock conflicts? Option A: Shopify always wins (ecommerce sync overwrites WA price). Option B: WhatsApp price is independent (sale_price overrides). This affects the sync logic design.

2. **Currency per-account** — `accounts` already has a `default_currency` column (migration 021). Is that the single currency per tenant, or do you need multi-currency per product (like Shopify variants)?

3. **Coupon entry UX** — Should coupon redemption happen via a **WhatsApp Flow** (native Meta interactive experience) or a simpler **keyword/list-based conversational step** built on the existing Flows engine (`collect_input` → `condition` nodes)? The former requires WhatsApp Flows API access (separate approval); the latter works today with zero new Meta permissions.

4. **Order notification channel** — When an order status changes (confirmed/fulfilled/cancelled), should the notification back to the customer be: (a) a free-form text (works within 24h window), (b) a pre-approved template (works anytime, requires template approval), or both based on timing?

5. **Commerce eligibility gating** — Should ineligible accounts (no Meta Commerce Policy approval) see the Shop tab at all, or just a banner inside it?

---

## Proposed Changes

---

### Phase 1 — Schema Extensions (≈ 3–4 days effort)

> [!IMPORTANT]
> All migrations are additive (no column drops). Run via `supabase migration new` and push to staging first.

#### [MODIFY] `043_whatsapp_native_commerce.sql` (via new migration)

**New migration: `049_whatsapp_commerce_v2.sql`**

```sql
-- 1. Extend whatsapp_products
ALTER TABLE whatsapp_products
  ADD COLUMN IF NOT EXISTS sale_price     NUMERIC(12,2),         -- NULL = no discount
  ADD COLUMN IF NOT EXISTS category       TEXT,
  ADD COLUMN IF NOT EXISTS brand          TEXT,
  ADD COLUMN IF NOT EXISTS sync_status    TEXT NOT NULL DEFAULT 'pending'
                                          CHECK (sync_status IN ('pending','synced','error')),
  ADD COLUMN IF NOT EXISTS sync_error     TEXT,
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ecommerce_product_id UUID
                           REFERENCES ecommerce_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'manual'
                                          CHECK (source IN ('manual','shopify','meta_import'));

CREATE INDEX IF NOT EXISTS idx_wa_products_ecommerce
  ON whatsapp_products(ecommerce_product_id) WHERE ecommerce_product_id IS NOT NULL;

-- 2. Extend whatsapp_orders — add conversation linkage + coupon tracking
ALTER TABLE whatsapp_orders
  ADD COLUMN IF NOT EXISTS conversation_id     UUID REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS coupon_id           UUID,           -- FK added after coupons table
  ADD COLUMN IF NOT EXISTS coupon_code         TEXT,
  ADD COLUMN IF NOT EXISTS discount_amount     NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS original_amount     NUMERIC(12,2); -- pre-discount total from Meta

-- 3. Coupons table
CREATE TABLE IF NOT EXISTS whatsapp_coupons (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  value          NUMERIC(10,2) NOT NULL,      -- % or currency amount
  applies_to     TEXT NOT NULL DEFAULT 'all'
                 CHECK (applies_to IN ('all','specific_products')),
  product_ids    UUID[] DEFAULT '{}',         -- only used when applies_to='specific_products'
  usage_limit    INT,                         -- NULL = unlimited
  used_count     INT NOT NULL DEFAULT 0,
  min_order_amt  NUMERIC(12,2),              -- minimum cart value to apply
  expires_at     TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, code)
);

-- 4. Per-contact coupon redemption log (abuse prevention)
CREATE TABLE IF NOT EXISTS whatsapp_coupon_redemptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id   UUID NOT NULL REFERENCES whatsapp_coupons(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  order_id    UUID REFERENCES whatsapp_orders(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(coupon_id, contact_id)           -- one redemption per contact per coupon
);

-- Add FK back to orders
ALTER TABLE whatsapp_orders
  ADD CONSTRAINT fk_order_coupon FOREIGN KEY (coupon_id)
  REFERENCES whatsapp_coupons(id) ON DELETE SET NULL;

-- RLS
ALTER TABLE whatsapp_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_coupon_redemptions ENABLE ROW LEVEL SECURITY;

-- (policies follow same is_account_member pattern as existing commerce tables)
```

**Prisma model additions** (`packages/prisma/schema.prisma` or wherever the schema lives):

```prisma
model whatsapp_products {
  // existing fields...
  sale_price            Decimal?       @db.Decimal(12, 2)
  category              String?
  brand                 String?
  sync_status           String         @default("pending")
  sync_error            String?
  last_synced_at        DateTime?
  ecommerce_product_id  String?        @db.Uuid
  source                String         @default("manual")
  ecommerce_product     ecommerce_products? @relation(fields: [ecommerce_product_id], references: [id])
}

model whatsapp_orders {
  // existing fields...
  conversation_id   String?   @db.Uuid
  coupon_id         String?   @db.Uuid
  coupon_code       String?
  discount_amount   Decimal   @default(0) @db.Decimal(12, 2)
  original_amount   Decimal?  @db.Decimal(12, 2)
  conversations     conversations?  @relation(fields: [conversation_id], references: [id])
  coupon            whatsapp_coupons? @relation(fields: [coupon_id], references: [id])
}

model whatsapp_coupons {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  account_id     String    @db.Uuid
  code           String
  discount_type  String
  value          Decimal   @db.Decimal(10, 2)
  applies_to     String    @default("all")
  product_ids    String[]  @db.Uuid
  usage_limit    Int?
  used_count     Int       @default(0)
  min_order_amt  Decimal?  @db.Decimal(12, 2)
  expires_at     DateTime?
  is_active      Boolean   @default(true)
  created_at     DateTime  @default(now())
  updated_at     DateTime  @default(now())
  accounts       accounts  @relation(fields: [account_id], references: [id], onDelete: Cascade)
  orders         whatsapp_orders[]
  redemptions    whatsapp_coupon_redemptions[]
  @@unique([account_id, code])
}

model whatsapp_coupon_redemptions {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  coupon_id   String   @db.Uuid
  contact_id  String   @db.Uuid
  order_id    String?  @db.Uuid
  redeemed_at DateTime @default(now())
  coupon      whatsapp_coupons @relation(fields: [coupon_id], references: [id], onDelete: Cascade)
  contact     contacts @relation(fields: [contact_id], references: [id], onDelete: Cascade)
  order       whatsapp_orders? @relation(fields: [order_id], references: [id])
  @@unique([coupon_id, contact_id])
}
```

---

### Phase 2 — Catalog Setup & Shopify Sync (≈ 4–5 days)

> **What already exists:** `POST /whatsapp/products/sync` (push all to Meta), `POST /whatsapp/products/import` (pull all from Meta). Both call `syncCatalogItems` / `fetchCatalogProducts` in `meta-api.util.ts`.
>
> **What's missing:** (a) per-product sync status tracking, (b) sale_price sent to Meta, (c) Shopify → whatsapp_products bridging.

#### [MODIFY] [whatsapp-shop.controller.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/whatsapp/controllers/whatsapp-shop.controller.ts)

- In `syncProductsToMeta`: after successful batch, `UPDATE whatsapp_products SET sync_status='synced', last_synced_at=NOW()` for successful items; `sync_status='error', sync_error=<message>` for items in the error list.
- Map `sale_price` to Meta's `sale_price` field (100x integer, same as `price`). When `sale_price` is set: send `"sale_price": <cents>` alongside `"price": <cents>` in the catalog item — Meta renders the strikethrough.
- Add `GET /whatsapp/products/sync-status` endpoint: returns per-product `{ id, sync_status, sync_error, last_synced_at }`.

#### [NEW] `apps/api/src/ecommerce/services/shopify-to-whatsapp-sync.service.ts`

```typescript
@Injectable()
export class ShopifyToWhatsappSyncService {
  /**
   * Called after a successful Shopify product sync into ecommerce_products.
   * Upserts into whatsapp_products keyed by ecommerce_product_id.
   * Never overwrites sale_price if the product has source='manual'
   * (respects the "WA price is independent" option).
   */
  async syncFromEcommerce(accountId: string, ecommerceProductId: string): Promise<void>
  
  /**
   * Bulk version — called by the Shopify webhook handler on product.updated.
   */
  async bulkSyncFromEcommerce(accountId: string): Promise<{ synced: number; errors: string[] }>
}
```

**Integration point:** `EcommerceController` already handles Shopify webhooks. After `ecommerce_products` upsert, call `ShopifyToWhatsappSyncService.syncFromEcommerce(...)` as fire-and-forget.

#### [MODIFY] [meta-api.util.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/whatsapp/meta-api.util.ts)

- Extend `CatalogProductInput` interface with optional `salePrice?: number` and `category?: string`. Pass through in `syncCatalogItems` batch payload.

#### Commerce Eligibility Gating

Add a `commerce_eligible` boolean to `whatsapp_config` (new migration column). The `GET /whatsapp/config` response already surfaces the config — surface `commerce_eligible: false` when `catalog_id` is null **or** when a `GET /{catalog_id}` preflight returns a commerce-policy-blocked error code. Show a banner in the Shop tab explaining the steps:
1. Complete Meta Commerce Policy review.
2. Enable WhatsApp Pay (where available) or configure checkout URL.
3. Set `catalog_id` in WhatsApp Settings.

---

### Phase 3 — Catalog Message Sending via Conversations (≈ 3 days)

> **What already exists:** `sendProductMessage` and `sendProductListMessage` in `meta-api.util.ts` are fully implemented.
>
> **What's missing:** A NestJS service that loads account credentials and persists the outbound message, plus a Flow node type for automation integration.

#### [NEW] `apps/api/src/whatsapp/services/whatsapp-commerce-send.service.ts`

```typescript
@Injectable()
export class WhatsappCommerceSendService {
  /**
   * Send a single-product card into an existing conversation.
   * Persists an outbound message record (content_type='interactive').
   */
  async sendSingleProduct(args: {
    accountId: string;
    conversationId: string;
    contactId: string;
    retailerId: string;
    bodyText?: string;
    footerText?: string;
  }): Promise<{ whatsapp_message_id: string }>

  /**
   * Send a multi-product list (up to 30 products in sections).
   * Maps our whatsapp_products to product_list sections.
   */
  async sendProductList(args: {
    accountId: string;
    conversationId: string;
    contactId: string;
    headerText: string;
    bodyText: string;
    footerText?: string;
    sections: Array<{ title: string; retailerIds: string[] }>;
  }): Promise<{ whatsapp_message_id: string }>

  /**
   * Send a full catalog message (no specific products — customer browses).
   * Uses the `catalog_message` interactive type introduced in Cloud API v17.
   */
  async sendFullCatalog(args: {
    accountId: string;
    conversationId: string;
    contactId: string;
    bodyText: string;
    footerText?: string;
    thumbnailRetailerId?: string; // optional hero product
  }): Promise<{ whatsapp_message_id: string }>
}
```

#### [NEW] REST endpoints on existing `WhatsappShopController`

```
POST /whatsapp/conversations/:conversationId/send-product
POST /whatsapp/conversations/:conversationId/send-product-list
POST /whatsapp/conversations/:conversationId/send-catalog
```

#### Flow Engine Integration — new `send_product` node type

#### [MODIFY] [flow.types.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/flows/flow.types.ts)

Add to the `FlowNodeConfig` union:

```typescript
export interface SendProductNodeConfig {
  /** 'single' | 'list' | 'catalog' */
  product_mode: 'single' | 'list' | 'catalog';
  /** For 'single': one retailer_id. */
  retailer_id?: string;
  /** For 'list': sections of retailer_ids. */
  sections?: Array<{ title: string; retailer_ids: string[] }>;
  header_text?: string;
  body_text?: string;
  footer_text?: string;
  next_node_key: string;
}
// Add to union: | { node_type: 'send_product'; config: SendProductNodeConfig }
```

#### [MODIFY] `flows/services/flow-dispatch.service.ts` (runner)

Handle `send_product` node type — delegate to `WhatsappCommerceSendService`. Already follows the pattern used for `send_message`, `send_buttons`, `send_media` nodes.

**Automation keyword trigger:** The existing automation `keyword_match` trigger + `WhatsApp message` action already fires. No change needed — the flow keyword trigger is the canonical "send catalog when user says 'shop'" path.

---

### Phase 4 — Order Webhook Enhancements & Status Lifecycle (≈ 3 days)

> **What already exists:** `whatsapp-webhook.service.ts` already creates a `whatsapp_orders` record on `order` message type (lines 510–554). The order gets `contact_id` set.
>
> **What's missing:** (a) `conversation_id` not linked, (b) no notification back to customer on status change, (c) coupon validation at order receipt.

#### [MODIFY] [whatsapp-webhook.service.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/whatsapp/services/whatsapp-webhook.service.ts)

In the `order` handling block (around line 540):
```typescript
await this.prisma.whatsapp_orders.create({
  data: {
    account_id: accountId,
    contact_id: contactRecord.id,
    conversation_id: conversation.id,   // ← ADD THIS
    whatsapp_message_id: message.id,
    // ...
    original_amount: totalAmount,       // ← store pre-discount amount
  }
});
```

Also fire a `order.created` webhook event via `webhookDeliver`.

#### [NEW] `apps/api/src/whatsapp/services/whatsapp-order-notify.service.ts`

```typescript
@Injectable()
export class WhatsappOrderNotifyService {
  /**
   * Send a status-change notification to the customer.
   * Tries free-form text first (24h window); falls back to a
   * pre-approved template if provided in whatsapp_config.
   *
   * Status messages:
   *   confirmed  → "Your order #{id} has been confirmed! 🎉 ..."
   *   fulfilled  → "Your order #{id} has been shipped/fulfilled ..."
   *   cancelled  → "Your order #{id} has been cancelled. ..."
   */
  async notifyStatusChange(args: {
    accountId: string;
    orderId: string;
    newStatus: 'confirmed' | 'fulfilled' | 'cancelled';
  }): Promise<void>
}
```

#### [MODIFY] [whatsapp-shop.controller.ts](file:///c:/Users/OMEN/Siva/whatsapp-crm/apps/api/src/whatsapp/controllers/whatsapp-shop.controller.ts)

In `updateOrder` (`PATCH /whatsapp/orders/:id`): after successful status update, call `WhatsappOrderNotifyService.notifyStatusChange(...)` as fire-and-forget.

---

### Phase 5 — Coupon / Discount System (≈ 4–5 days)

> Meta has no native coupon object. Approach B (conversational code entry) is recommended because it requires zero additional Meta permissions. Approach A (sale_price sync) is already partially covered by Phase 2's `sale_price` field.

#### Recommended Architecture: Hybrid A + B

- **Always-on discounts (Approach A):** Use `sale_price` on `whatsapp_products`. This shows the strikethrough price natively in the WhatsApp product card. No coupon code needed.
- **One-time coupon codes (Approach B):** A `collect_input` → `condition` flow captures the code before checkout:

```
[send_product_list] → [collect_input: "Enter coupon code (or skip)"] 
  → [condition: var.coupon_code present]
    true  → POST /whatsapp/coupons/validate (server-side check)
           → [send_message: "✅ Coupon applied! X% off"]
    false → [send_product_list: "Browse without discount"]
```

The coupon code is stored in `flow_runs.vars`. When the `order` webhook arrives, the webhook handler:
1. Looks up the contact's active flow run's `vars.coupon_code`.
2. Calls `CouponService.validateAndApply(code, contactId, orderTotal)`.
3. Stores `coupon_id`, `coupon_code`, `discount_amount` on the order.
4. Increments `used_count` and creates a `whatsapp_coupon_redemptions` row atomically.

#### [NEW] `apps/api/src/whatsapp/services/whatsapp-coupon.service.ts`

```typescript
@Injectable()
export class WhatsappCouponService {
  /**
   * Pure validation — does NOT consume the coupon.
   * Returns the discount amount for a given order total.
   * Throws if: expired, usage_limit hit, contact already redeemed,
   *            cart below min_order_amt, or coupon inactive.
   */
  async validate(args: {
    code: string;
    accountId: string;
    contactId: string;
    orderTotal: number;
    productIds?: string[];
  }): Promise<{ couponId: string; discountAmount: number; finalTotal: number }>

  /**
   * Atomically: create redemption row + increment used_count + return discount.
   * Uses Prisma.$transaction to prevent double-spend under concurrent order events.
   */
  async applyToOrder(args: {
    couponId: string;
    contactId: string;
    orderId: string;
  }): Promise<{ discountAmount: number }>
}
```

#### [NEW] REST endpoints — `WhatsappCouponsController`

```
GET    /whatsapp/coupons              → list (account-scoped)
POST   /whatsapp/coupons              → create
PATCH  /whatsapp/coupons/:id          → update (deactivate, change value etc.)
DELETE /whatsapp/coupons/:id          → soft-delete (set is_active=false)
POST   /whatsapp/coupons/validate     → public-ish: contact submits a code, returns discount preview
GET    /whatsapp/coupons/:id/stats    → redemption count, orders, revenue impact
```

#### Abuse Prevention

| Risk | Mitigation |
|------|-----------|
| Same contact redeems twice | `@@unique([coupon_id, contact_id])` on `whatsapp_coupon_redemptions` + Prisma transaction |
| Race condition (two concurrent orders) | `$transaction` with `FOR UPDATE` lock on the coupon row (Prisma raw query) |
| Code guessing | Rate-limit `POST /coupons/validate` to 5 req/min per `contactId` via `ThrottlerGuard` |
| Expired coupon still cached in flow var | Validate at order-receipt time, not just at collect-input time |

---

### Phase 6 — Dashboard UI (Next.js) (≈ 6–8 days)

> The Next.js app uses the App Router. Check `node_modules/next/dist/docs/` before writing route files per the project rules.

#### [MODIFY/NEW] `apps/web/src/app/(dashboard)/shop/` — new tab group

**Products Catalog Manager** (`/shop/products`)
- Table: name, retailer_id, price, sale_price (strike-through if set), category, sync_status badge, last_synced_at.
- Bulk actions: "Sync all to Meta", "Import from Meta", "Set active/inactive".
- Product drawer/modal: all fields including `sale_price`, `category`, `brand`, `image_url` (with upload).
- Sync status column: `pending` (grey), `synced` (green check + relative time), `error` (red with tooltip showing `sync_error`).
- Source badge: "Manual" | "Shopify" | "Meta Import".

**Orders View** (`/shop/orders`)
- Table: order ID (short), contact name + phone (linked to contact page), total (with `discount_amount` if non-zero), status badge, created_at.
- Status dropdown inline (calls `PATCH /whatsapp/orders/:id`).
- Order detail side panel: items JSON rendered as a table, coupon applied, conversation link.

**Coupons Manager** (`/shop/coupons`)
- Table: code, type, value, uses/limit, expires, active toggle.
- Create/edit dialog: discount_type selector, value input, applies_to toggle (all / specific products with multi-select), usage_limit, min_order_amt, expires_at.
- Stats card per coupon: total redemptions, total discount given, orders linked.

#### Commerce Eligibility Banner

When `catalog_id` is null on `whatsapp_config`, show a full-width banner on all `/shop/*` pages:
```
⚠️ WhatsApp Commerce is not set up yet.
   Add your Meta Catalog ID in WhatsApp Settings → Catalog ID.
   [Go to Settings →]
```

---

### Phase 7 — Edge Cases & Hardening (≈ 2–3 days)

| Edge Case | Resolution |
|-----------|-----------|
| **Commerce policy not approved** | Detect `#100 / error_subcode 2388052` from Meta on catalog ops → set `commerce_eligible=false` on config, show actionable banner: "Complete Meta Commerce Policy review at business.facebook.com" |
| **Multi-currency per account** | `accounts.default_currency` (migration 021) drives defaults. Per-product `currency` already exists. Orders store their own `currency`. Exchange rate conversion is out of scope — surface raw currencies in the dashboard and let agents handle. |
| **Shopify price/stock conflicts** | When `source='shopify'`, `syncFromEcommerce` only overwrites `price`, `name`, `is_active` (stock). It never touches `sale_price` (always manual). When `source='manual'`, Shopify sync is skipped for that product (explicit override). |
| **Deleted Shopify product** | `ecommerce_products` soft-delete → Shopify sync sets `whatsapp_products.is_active=false` and `sync_status='pending'` (next sync will remove from Meta catalog). |
| **Order webhook duplicate** | `whatsapp_message_id UNIQUE` constraint already on `whatsapp_orders` — duplicate order events from Meta silently fail with P2002. |
| **24h window for status notifications** | `WhatsappOrderNotifyService` tries free-form text first. If it gets a `131026` (outside window) error from Meta, log a warning and optionally queue a template send. |
| **Coupon on out-of-window orders** | Coupon validation happens server-side at `order` webhook receipt — no timing dependency on the 24h window. |

---

## Verification Plan

### Automated Tests
- `npx jest --testPathPattern=whatsapp-shop` — existing shop controller tests cover products/orders CRUD.
- Add: `whatsapp-coupon.service.spec.ts` — unit test `validate()` for all rejection cases (expired, over-limit, double-redeem, below min_amt).
- Add: `whatsapp-order-notify.service.spec.ts` — mock Meta API, assert template/text fallback logic.

### Manual Verification
1. Create a product with `sale_price` → Sync → verify strikethrough in a test WhatsApp conversation.
2. Place a test order via WhatsApp → confirm `whatsapp_orders` record with `conversation_id` populated.
3. Update order status to `confirmed` → confirm customer receives notification message.
4. Create a coupon, enter code in a `collect_input` flow → place order → verify `discount_amount` on the order row and `whatsapp_coupon_redemptions` entry.
5. Try to redeem same coupon twice from same contact → expect rejection at order receipt.
6. Remove `catalog_id` from config → confirm eligibility banner appears on `/shop/*`.

---

## Effort Summary

| Phase | Scope | Estimated Effort |
|-------|-------|-----------------|
| 1 | Schema (migration + Prisma) | 3–4 days |
| 2 | Catalog sync enhancements + Shopify bridge | 4–5 days |
| 3 | Commerce message sending + Flow node | 3 days |
| 4 | Order webhook enhancements + notifications | 3 days |
| 5 | Coupon system (service + controller) | 4–5 days |
| 6 | Dashboard UI (3 pages) | 6–8 days |
| 7 | Edge case hardening + tests | 2–3 days |
| **Total** | | **~25–31 dev-days** |

A solo developer working full-time could complete this in **5–7 weeks**. Phases 1–4 can be parallelised against Phase 6 UI work once the API contracts are defined.
