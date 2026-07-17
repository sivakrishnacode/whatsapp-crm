import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Used by the Prisma CLI only (generate/migrate/db pull) — the running
// NestJS app never reads this file. Runtime connections go through the
// @prisma/adapter-pg driver adapter in src/prisma/prisma.service.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
