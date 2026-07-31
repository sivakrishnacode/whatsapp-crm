import { describe, expect, it } from 'vitest';
import {
  toE164,
  isCanonicalE164,
  metaVariantToE164,
  normalizePhone,
  sanitizePhoneForMeta,
  phoneVariants,
} from './phone.util';

/**
 * These cases mirror apps/web/src/lib/whatsapp/phone-utils.test.ts.
 * The two implementations are deliberate twins — the dashboard writes
 * contacts through Supabase directly and the API writes them through
 * Prisma, so a disagreement between them is a mixed-format bug, and
 * this file is what catches one.
 */

describe('toE164', () => {
  it('keeps an already-canonical number unchanged', () => {
    expect(toE164('+919791766444', 'IN')).toBe('+919791766444');
    expect(toE164('+14155550123', 'US')).toBe('+14155550123');
  });

  it('adds the missing + to a number that already carries its country code', () => {
    // Meta's inbound webhook `from` is digits only; storing it verbatim
    // is what started the drift this module exists to end.
    expect(toE164('918300070574', 'IN')).toBe('+918300070574');
    expect(toE164('919791766444', 'IN')).toBe('+919791766444');
  });

  it("adds the default country's code to a bare national number", () => {
    expect(toE164('9791766444', 'IN')).toBe('+919791766444');
    expect(toE164('4155550123', 'US')).toBe('+14155550123');
  });

  it('resolves the same digits differently per account country', () => {
    expect(toE164('4155550123', 'IN')).toBe('+914155550123');
    expect(toE164('4155550123', 'US')).toBe('+14155550123');
  });

  it('drops a domestic trunk prefix', () => {
    expect(toE164('07810032625', 'IN')).toBe('+917810032625');
    expect(toE164('00919791766444', 'IN')).toBe('+919791766444');
  });

  it('strips punctuation and whitespace', () => {
    expect(toE164('+91 78100 32625', 'IN')).toBe('+917810032625');
    expect(toE164('(415) 555-0123', 'US')).toBe('+14155550123');
    expect(toE164('  +14155550123  ', 'US')).toBe('+14155550123');
  });

  it('prefers a valid foreign reading over the default country', () => {
    expect(toE164('447911123456', 'IN')).toBe('+447911123456');
  });

  it('returns null for input that is not a phone number', () => {
    expect(toE164('1234', 'IN')).toBeNull();
    expect(toE164('abc', 'IN')).toBeNull();
    expect(toE164('', 'IN')).toBeNull();
    expect(toE164(null, 'IN')).toBeNull();
    expect(toE164(undefined, 'IN')).toBeNull();
  });

  it('falls back to the international reading when the country is unusable', () => {
    // resolveAccountCountry already narrows bad values, but a stale
    // column or a direct caller must not throw inside libphonenumber.
    expect(toE164('918300070574', '')).toBe('+918300070574');
    expect(toE164('918300070574', '91')).toBe('+918300070574');
    expect(toE164('918300070574', null)).toBe('+918300070574');
  });

  it('is idempotent', () => {
    const once = toE164('9791766444', 'IN');
    expect(toE164(once, 'IN')).toBe(once);
  });

  it('always produces something the CHECK constraint accepts', () => {
    const inputs = [
      '9791766444',
      '918300070574',
      '+917010002624',
      '07810032625',
      '447911123456',
      '(415) 555-0123',
    ];
    for (const raw of inputs) {
      const canonical = toE164(raw, 'IN');
      expect(canonical).not.toBeNull();
      expect(isCanonicalE164(canonical as string)).toBe(true);
    }
  });

  it('agrees with normalizePhone on the de-dup key', () => {
    // Canonicalizing must not move a contact to a different bucket in
    // the phone_normalized unique index (migration 022).
    for (const raw of ['9791766444', '919791766444', '+91 97917 66444']) {
      expect(normalizePhone(toE164(raw, 'IN') as string)).toBe('919791766444');
    }
  });
});

describe('isCanonicalE164', () => {
  it('accepts only the exact stored form', () => {
    expect(isCanonicalE164('+919791766444')).toBe(true);
    // Same invariant as contacts_phone_e164_chk (migration 061).
    expect(isCanonicalE164('919791766444')).toBe(false);
    expect(isCanonicalE164('+0919791766444')).toBe(false);
    expect(isCanonicalE164('+91 97917 66444')).toBe(false);
    expect(isCanonicalE164('')).toBe(false);
  });
});

describe('metaVariantToE164', () => {
  it('restores the + on a variant Meta accepted', () => {
    expect(metaVariantToE164('37063949836')).toBe('+37063949836');
  });

  it('preserves a trunk digit that made the send work', () => {
    // The whole point of the retry: +370 0639… is the shape this
    // sandbox is registered under, so re-parsing and "correcting" it
    // would undo the fix being written back.
    const variant = phoneVariants(sanitizePhoneForMeta('+37063949836')).find(
      (v) => v === '370063949836',
    );
    expect(variant).toBe('370063949836');
    expect(metaVariantToE164(variant as string)).toBe('+370063949836');
  });

  it('returns null rather than a value the constraint would reject', () => {
    expect(metaVariantToE164('')).toBeNull();
    expect(metaVariantToE164('123')).toBeNull();
    expect(metaVariantToE164('0123456789')).toBeNull();
  });
});
