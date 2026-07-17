import type { AccountRole } from '@prisma/client';

/** Cookie-session (Supabase Auth) caller — the dashboard. */
export interface SupabaseAccountContext {
  authType: 'supabase';
  userId: string;
  accountId: string;
  role: AccountRole;
  account: { id: string; name: string };
}

/** Bearer API-key caller — the public API. */
export interface ApiKeyAccountContext {
  authType: 'api_key';
  accountId: string;
  keyId: string;
  scopes: string[];
  createdBy: string | null;
}

export type AccountContext = SupabaseAccountContext | ApiKeyAccountContext;

export type { AccountRole };
