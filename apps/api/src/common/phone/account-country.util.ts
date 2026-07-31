import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_COUNTRY } from './phone.util';

/**
 * Resolve an account's default country (ISO 3166-1 alpha-2) for
 * phone normalization.
 *
 * A bare national number — `9791766444` off a web form, a CSV column
 * of local numbers — carries no country code, so canonicalizing it
 * to E.164 needs one assumed. `accounts.default_country` (migration
 * 059) is that assumption, per tenant: a US account's 10-digit
 * numbers must not become `+91…`.
 *
 * ## Why a plain function with a module cache, not a Nest provider
 *
 * The contact write paths are split between injectable services
 * (webhook, forms, web sessions) and plain util functions that
 * already take `prisma` as an argument (`v1/utils/contacts.util.ts`,
 * `v1/utils/resolve-conversation.util.ts`). A function both can call
 * needs no DI wiring at the util call sites.
 *
 * The cache matters because the WhatsApp webhook resolves a country
 * for every inbound message; without it a busy account adds one
 * `accounts` SELECT per message. Entries are short-lived so a
 * settings change takes effect within a minute rather than needing a
 * deploy, and `invalidateAccountCountry` makes it immediate for the
 * process that handled the write.
 */

const TTL_MS = 60_000;

const cache = new Map<string, { country: string; expiresAt: number }>();

/**
 * The account's default country, or {@link DEFAULT_COUNTRY} when the
 * account is missing or holds an unusable value.
 *
 * Never throws: this sits on the inbound-message path, and a country
 * lookup failing is not a reason to drop a customer's message. A bad
 * or absent value degrades to the app-wide default, which is exactly
 * the behaviour before the column existed.
 */
export async function resolveAccountCountry(
  prisma: PrismaService,
  accountId: string,
): Promise<string> {
  const hit = cache.get(accountId);
  if (hit && hit.expiresAt > Date.now()) return hit.country;

  let country = DEFAULT_COUNTRY;
  try {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { defaultCountry: true },
    });
    const value = account?.defaultCountry;
    if (value && /^[A-Za-z]{2}$/.test(value)) {
      country = value.toUpperCase();
    }
  } catch {
    // Fall through to DEFAULT_COUNTRY.
  }

  cache.set(accountId, { country, expiresAt: Date.now() + TTL_MS });
  return country;
}

/** Drop a cached country so the next resolve re-reads the row. */
export function invalidateAccountCountry(accountId: string): void {
  cache.delete(accountId);
}

/** Test seam — clears every cached entry. */
export function clearAccountCountryCache(): void {
  cache.clear();
}
