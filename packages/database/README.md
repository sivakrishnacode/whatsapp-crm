# @repo/database

The **one** Prisma schema for the monorepo. `apps/api` and `apps/admin-panel`
both talk to the same Supabase Postgres, so the schema lives here rather than
inside either app — there is no second copy to drift.

```
prisma/schema.prisma            dual schema: ["auth", "public"]
prisma/migrations/              Prisma's baseline (0_init_supabase)
prisma/bootstrap-role.sql       manual, one-time: creates the "prisma" role
prisma.config.ts                CLI config; reads DATABASE_URL from apps/api/.env
```

Day-to-day SQL migrations are still hand-written in `supabase/migrations/` and
applied with `scripts/run-migration.sh`. This package's job is the Prisma
_client_ and the schema that types it.

## Commands

Run from the repo root:

| Command               | What it does                                         |
| --------------------- | ---------------------------------------------------- |
| `npm run db:generate` | Regenerate the Prisma client (after any schema edit) |
| `npm run db:studio`   | Open Prisma Studio                                   |
| `npm run db:push`     | Push the schema to the database without a migration  |
| `npm run db:migrate`  | Create + apply a Prisma migration                    |

`npm run build` runs `db:generate` first for anything that depends on this
package (see `turbo.json`), so a fresh clone builds without a manual step.

## Consuming it

The generator is `prisma-client-js`, so the client is generated into the
workspace's `node_modules/.prisma/client` and imported the usual way:

```ts
import { PrismaClient, type Prisma } from '@prisma/client';
```

Each app owns its own connection setup, because the lifecycles differ — Nest
binds the client to a module (`OnModuleInit`/`OnModuleDestroy`), Next.js keeps
a single client on `globalThis` across dev hot reloads. What they share is this
schema, not the plumbing.

Add `"@repo/database": "*"` to an app's dependencies so Turborepo knows to
generate before building it.

## Editing the schema

1. Write the SQL migration in `supabase/migrations/` and apply it.
2. Reconcile `prisma/schema.prisma` to match.
3. `npm run db:generate`, then `npm run typecheck` and fix the fallout.

Keep the `auth.*` models read-mostly — Supabase owns that schema.
