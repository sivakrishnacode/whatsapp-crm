import 'server-only';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { databaseUrl } from '@/lib/env';

/**
 * The panel's Prisma client.
 *
 * Schema comes from `@repo/database` (packages/database) — the same one the
 * NestJS api is typed against, so there is exactly one definition of the
 * database in this monorepo. Only the connection setup is per-app, because the
 * lifecycles differ: Nest binds a client to a module, Next.js has to survive
 * hot reloads without opening a new pool on every edit.
 */

const globalForPrisma = globalThis as unknown as {
  adminPrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl() }),
  });
}

export const prisma: PrismaClient =
  globalForPrisma.adminPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.adminPrisma = prisma;
}
