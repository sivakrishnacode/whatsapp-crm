import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Used by the Prisma CLI only (generate/migrate/db pull) — no running app
// reads this file. Runtime connections go through the @prisma/adapter-pg
// driver adapter each app builds for itself (apps/api/src/prisma/prisma.service.ts,
// apps/admin-panel/lib/prisma.ts).
//
// DATABASE_URL is not copied here for the CLI's sake: the api's env file is
// where it already lives, so that is what we read. A local
// packages/database/.env wins if you need to point the CLI somewhere else
// (a branch database, a scratch copy) without touching the api's env.
loadEnv({ path: ['.env', '../../apps/api/.env'], quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
