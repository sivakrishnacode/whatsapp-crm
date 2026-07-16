import { SetMetadata } from '@nestjs/common';
import type { AccountRole } from '@prisma/client';

export const REQUIRE_ROLE_KEY = 'requireRole';

/** Declares the minimum account role a route requires. Read by `SupabaseAuthGuard`. */
export const RequireRole = (minRole: AccountRole) =>
  SetMetadata(REQUIRE_ROLE_KEY, minRole);
