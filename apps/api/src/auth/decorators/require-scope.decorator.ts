import { SetMetadata } from '@nestjs/common';

export const API_SCOPES = [
  'messages:send',
  'messages:read',
  'contacts:read',
  'contacts:write',
  'conversations:read',
  'broadcasts:send',
  'webhooks:manage',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const REQUIRE_SCOPE_KEY = 'requireScope';

/** Declares the single scope an `/api/v1`-style route requires. Read by `ApiKeyGuard`. */
export const RequireScope = (scope: ApiScope) =>
  SetMetadata(REQUIRE_SCOPE_KEY, scope);
