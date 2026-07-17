-- ============================================================
-- MANUAL, ONE-TIME SETUP — run this yourself in the Supabase SQL
-- editor (Dashboard -> SQL Editor -> New query). Nothing in this
-- repo executes this file automatically.
--
-- Creates the Postgres role Prisma connects as. `bypassrls` is
-- intentional: Prisma is the app-layer's direct-to-Postgres path,
-- and authorization for anything going through it is enforced in
-- NestJS guards/services (see apps/api/src/auth), not RLS. RLS
-- stays enabled and in effect for every other role (anon,
-- authenticated, service_role) — this only affects the "prisma" role.
--
-- Source: notes/prisma-migration.md (Supabase's own Prisma quickstart).
-- ============================================================

create user "prisma" with password 'REPLACE_WITH_A_GENERATED_PASSWORD' bypassrls createdb;

-- extend prisma's privileges to postgres (lets the Dashboard/table
-- editor keep showing rows written via Prisma)
grant "prisma" to "postgres";

grant usage on schema public to prisma;
grant create on schema public to prisma;
grant all on all tables in schema public to prisma;
grant all on all routines in schema public to prisma;
grant all on all sequences in schema public to prisma;
alter default privileges for role postgres in schema public grant all on tables to prisma;
alter default privileges for role postgres in schema public grant all on routines to prisma;
alter default privileges for role postgres in schema public grant all on sequences to prisma;

-- To rotate the password later:
-- alter user "prisma" with password 'new_password';
