/**
 * Rewrite every `contacts.phone` to canonical E.164.
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF THE MIGRATION
 *   Canonicalizing a bare national number (`9791766444`) means
 *   deciding which country it belongs to, and disambiguating that
 *   from a number that already carries a country code
 *   (`918300070574`) needs libphonenumber's per-country metadata.
 *   Reimplementing that in plpgsql would be a worse copy of the rule
 *   the app already applies on every write, and the two would drift.
 *   So the migration pair does the schema (059) and the constraint
 *   (061), and the data rewrite runs here through the very same
 *   `toE164` the API writes with.
 *
 * ORDER
 *   1. supabase/migrations/059_contact_phone_e164.sql
 *   2. this script (--apply)
 *   3. supabase/migrations/060_contact_phone_e164_constraint.sql
 *   060 refuses to apply if step 2 was skipped.
 *
 * USAGE
 *   cd apps/api
 *   npx tsx scripts/backfill-contact-phones.ts            # dry run
 *   npx tsx scripts/backfill-contact-phones.ts --apply    # write
 *
 * Dry run by default: it prints every change it would make, including
 * the rows it cannot canonicalize, so the plan is reviewable before
 * anything is written. Re-runnable — already-canonical rows are
 * skipped, so a second --apply is a no-op.
 *
 * Requires DATABASE_URL in the environment (.env is loaded
 * automatically).
 */

import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  toE164,
  isCanonicalE164,
  DEFAULT_COUNTRY,
} from '../src/common/phone/phone.util';

/** Postgres 23505 as Prisma reports it — a duplicate phone. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message.split('\n').pop()!.trim() : String(err);
}

async function main() {
  const apply = process.argv.includes('--apply');

  // Prisma 7 requires an explicit driver adapter — same construction
  // as PrismaService, so this script talks to the database exactly the
  // way the running api does.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const accounts = await prisma.account.findMany({
      select: { id: true, name: true, defaultCountry: true },
    });
    const countryByAccount = new Map(
      accounts.map((a) => [a.id, a.defaultCountry || DEFAULT_COUNTRY]),
    );

    const contacts = await prisma.contacts.findMany({
      where: { phone: { not: null } },
      // created_at is selected, not just ordered by: the merge path
      // below picks a survivor from it, and reading it off an
      // unselected field silently made every comparison `undefined`.
      select: {
        id: true,
        account_id: true,
        phone: true,
        name: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
    });

    let unchanged = 0;
    const changes: Array<{ id: string; from: string; to: string }> = [];
    const unresolved: Array<{ id: string; phone: string; name: string | null }> =
      [];

    for (const contact of contacts) {
      const current = contact.phone as string;
      if (isCanonicalE164(current)) {
        unchanged++;
        continue;
      }

      const country =
        countryByAccount.get(contact.account_id) ?? DEFAULT_COUNTRY;
      const canonical = toE164(current, country);

      if (!canonical) {
        unresolved.push({ id: contact.id, phone: current, name: contact.name });
        continue;
      }
      changes.push({ id: contact.id, from: current, to: canonical });
    }

    console.log(
      `${contacts.length} contact(s) with a phone — ${unchanged} already canonical, ` +
        `${changes.length} to rewrite, ${unresolved.length} unresolvable.`,
    );

    for (const change of changes) {
      console.log(`  ${change.from.padEnd(20)} → ${change.to}`);
    }

    if (unresolved.length > 0) {
      // These block migration 061, and no automatic rule can fix them:
      // the stored value is not a phone number under any country's
      // rules. Report them individually so they can be corrected or
      // cleared by hand — guessing here is what produced the mess in
      // the first place.
      console.log(
        '\nCould not canonicalize (fix or clear these before running 060):',
      );
      for (const row of unresolved) {
        console.log(
          `  ${row.id}  ${JSON.stringify(row.phone)}  ${row.name ?? '(no name)'}`,
        );
      }
    }

    if (!apply) {
      console.log('\nDry run — nothing written. Re-run with --apply.');
      return;
    }

    // One UPDATE per row rather than a bulk statement, because some of
    // them are expected to fail.
    //
    // Two contacts whose digits differ today can canonicalize to the
    // same number — "9791766444" from the web widget and
    // "919791766444" from the WhatsApp webhook are one person filed
    // twice, which is the reported bug in its worst form. Once both
    // become +919791766444 the partial unique index on
    // (account_id, phone_normalized) rejects the second write.
    //
    // That rejection is the correct answer to "are these the same
    // person": yes. So the collision is resolved by merging rather
    // than by skipping — leaving them split would preserve exactly the
    // fragmentation this backfill exists to end. The older contact
    // survives and inherits every child row; see
    // merge_contacts_into() in migration 060.
    let written = 0;
    let merged = 0;
    const failures: Array<{ id: string; to: string; error: string }> = [];

    for (const change of changes) {
      try {
        await prisma.contacts.update({
          where: { id: change.id },
          data: { phone: change.to },
        });
        written++;
        continue;
      } catch (err) {
        if (!isUniqueViolation(err)) {
          failures.push({ id: change.id, to: change.to, error: describe(err) });
          continue;
        }
      }

      // Unique violation — find who already holds this number.
      const holder = await prisma.contacts.findFirst({
        where: {
          account_id: contacts.find((c) => c.id === change.id)!.account_id,
          phone_normalized: change.to.replace(/\D/g, ''),
        },
        select: { id: true, created_at: true, name: true },
      });
      const self = contacts.find((c) => c.id === change.id)!;

      if (!holder || holder.id === change.id) {
        failures.push({
          id: change.id,
          to: change.to,
          error: 'collided with a contact that could not be located',
        });
        continue;
      }

      // Oldest survives — the same rule migration 022 uses, and the
      // one that keeps the longer history as the primary record. A
      // missing timestamp sorts as "newer" so an unknown never wins
      // over a known one.
      const selfAt = self.created_at?.getTime() ?? Infinity;
      const holderAt = holder.created_at?.getTime() ?? Infinity;
      const selfIsOlder = selfAt < holderAt;
      const survivor = selfIsOlder ? change.id : holder.id;
      const loser = selfIsOlder ? holder.id : change.id;

      try {
        await prisma.$executeRaw`SELECT public.merge_contacts_into(${survivor}::uuid, ${loser}::uuid)`;
        // The survivor may still hold the old format if it was the
        // pre-existing row; make sure it ends up canonical.
        await prisma.contacts.update({
          where: { id: survivor },
          data: { phone: change.to },
        });
        merged++;
        console.log(
          `  merged ${JSON.stringify(self.name)} + ${JSON.stringify(holder.name)} → ${change.to}`,
        );
      } catch (err) {
        failures.push({ id: change.id, to: change.to, error: describe(err) });
      }
    }

    console.log(
      `\nRewrote ${written} contact(s); merged ${merged} duplicate pair(s).`,
    );

    if (failures.length > 0) {
      console.log(`\n${failures.length} row(s) could not be written:`);
      for (const f of failures) {
        console.log(`  ${f.id} → ${f.to}: ${f.error}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
