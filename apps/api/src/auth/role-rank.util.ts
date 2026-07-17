import type { AccountRole } from '@prisma/client';

/** Mirrors apps/web/src/lib/auth/roles.ts — keep both in sync until Phase 1+ retires the Next.js copy. */
const ROLE_RANK: Record<AccountRole, number> = {
  owner: 4,
  admin: 3,
  agent: 2,
  viewer: 1,
};

export function hasMinRole(role: AccountRole, min: AccountRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
