import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * Fleet-wide CRM / API operations (C360-012/013 from the operator's side).
 *
 * ⚠️ Never a secret: `api_keys.key_hash`, `webhook_endpoints.secret`,
 * `google_script_connections.exec_url` / `secret_encrypted` and the store
 * credentials are not selected. Webhook and store URLs are reduced to their
 * origin in SQL — a path or query string can carry a token, and the origin is
 * all anyone needs to diagnose a delivery.
 */

export type FleetApiKey = {
  id: string;
  accountId: string;
  accountName: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export type FleetWebhook = {
  id: string;
  accountId: string;
  accountName: string;
  origin: string;
  isActive: boolean;
  lastDeliveryAt: Date | null;
  createdAt: Date;
};

export type FleetGoogle = {
  accountId: string;
  accountName: string;
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  scriptVersion: number | null;
  createdAt: Date;
};

export type FleetStore = {
  accountId: string;
  accountName: string;
  platform: string;
  status: string;
  origin: string;
  lastSyncAt: Date | null;
  syncError: string | null;
};

/** `scheme://host[:port]` of a URL, in SQL. Anything unparsable → '(invalid URL)'. */
const ORIGIN = (column: Prisma.Sql) => Prisma.sql`
  coalesce(substring(${column} from '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+'), '(invalid URL)')`;

export async function getFleetIntegrations() {
  const [apiKeys, webhooks, google, stores] = await Promise.all([
    prisma.$queryRaw<FleetApiKey[]>(Prisma.sql`
      select k.id, k.account_id as "accountId", a.name as "accountName", k.name,
        k.key_prefix as "prefix", k.created_at as "createdAt",
        k.last_used_at as "lastUsedAt", k.expires_at as "expiresAt", k.revoked_at as "revokedAt"
      from api_keys k join accounts a on a.id = k.account_id
      order by (k.revoked_at is null) desc, k.last_used_at desc nulls last, k.created_at desc
    `),
    prisma.$queryRaw<FleetWebhook[]>(Prisma.sql`
      select w.id, w.account_id as "accountId", a.name as "accountName",
        ${ORIGIN(Prisma.sql`w.url`)} as "origin",
        w.is_active as "isActive", w.last_delivery_at as "lastDeliveryAt", w.created_at as "createdAt"
      from webhook_endpoints w join accounts a on a.id = w.account_id
      order by w.is_active desc, w.last_delivery_at desc nulls last
    `),
    prisma.$queryRaw<FleetGoogle[]>(Prisma.sql`
      select g.account_id as "accountId", a.name as "accountName",
        g.last_ok_at as "lastOkAt", g.last_error_at as "lastErrorAt", g.last_error as "lastError",
        g.script_version as "scriptVersion", g.created_at as "createdAt"
      from google_script_connections g join accounts a on a.id = g.account_id
      order by g.last_error_at desc nulls last
    `),
    prisma.$queryRaw<FleetStore[]>(Prisma.sql`
      select e.account_id as "accountId", a.name as "accountName", e.platform, e.status,
        ${ORIGIN(Prisma.sql`e.store_url`)} as "origin",
        e.last_sync_at as "lastSyncAt", e.sync_error as "syncError"
      from ecommerce_integrations e join accounts a on a.id = e.account_id
      order by (e.sync_error is not null) desc, e.last_sync_at desc nulls last
    `),
  ]);
  return { apiKeys, webhooks, google, stores };
}
