import { describe, expect, it } from "vitest";
import {
  isRecipientNotAllowedError,
  isValidE164,
  normalizePhone,
  phoneVariants,
  phonesMatch,
  sanitizePhoneForMeta,
  toE164,
  isCanonicalE164,
  formatPhoneDisplay,
} from "./phone-utils";

describe("sanitizePhoneForMeta", () => {
  it("strips +, spaces, and dashes leaving only digits", () => {
    expect(sanitizePhoneForMeta("+370 639 49836")).toBe("37063949836");
    expect(sanitizePhoneForMeta("+1 (415) 555-1212")).toBe("14155551212");
  });

  it("returns an empty string for falsy input", () => {
    expect(sanitizePhoneForMeta("")).toBe("");
    // Defensive: existing call sites occasionally pass through nullable
    // contact phones. The function early-returns on the falsy check.
    expect(sanitizePhoneForMeta(undefined as unknown as string)).toBe("");
  });

  it("is idempotent on already-sanitized input", () => {
    const cleaned = "14155551212";
    expect(sanitizePhoneForMeta(cleaned)).toBe(cleaned);
  });
});

describe("normalizePhone", () => {
  it("matches sanitizePhoneForMeta byte-for-byte (shared canonical form)", () => {
    const samples = ["+370 12345", "abc-555-DEF", "", "0044 7000 0000 0000"];
    for (const s of samples) {
      expect(normalizePhone(s)).toBe(sanitizePhoneForMeta(s));
    }
  });
});

describe("phonesMatch", () => {
  it("returns true for exact digit matches", () => {
    expect(phonesMatch("+37063949836", "37063949836")).toBe(true);
  });

  it("matches across trunk-prefix variants by last-8 fallback", () => {
    // Lithuanian trunk-0 variant. Last 8 digits ("63949836") collide.
    expect(phonesMatch("370063949836", "37063949836")).toBe(true);
  });

  it("rejects mismatched numbers", () => {
    expect(phonesMatch("+37063949836", "+37063949837")).toBe(false);
  });

  it("rejects very short inputs that would false-positive on tail match", () => {
    // Only 7 digits — the last-8 fallback is gated to len>=8 on both
    // sides to avoid declaring "12345" and "67890-12345" a match.
    expect(phonesMatch("1234567", "1234567")).toBe(true);
    expect(phonesMatch("1234567", "9991234567")).toBe(false);
  });

  it("ignores formatting noise on both sides", () => {
    expect(phonesMatch("+370 6 394 9836", "37063949836")).toBe(true);
    expect(phonesMatch("(415) 555-1212", "+1 415-555-1212")).toBe(true);
  });
});

describe("isValidE164", () => {
  it("accepts numbers 7–15 digits with optional + and non-zero start", () => {
    expect(isValidE164("+37063949836")).toBe(true);
    expect(isValidE164("37063949836")).toBe(true);
    expect(isValidE164("+1234567")).toBe(true); // 7 digits — lower bound
    expect(isValidE164("+123456789012345")).toBe(true); // 15 digits — upper bound
  });

  it("rejects numbers that start with 0 in international form", () => {
    expect(isValidE164("+0123456")).toBe(false);
    expect(isValidE164("0044700000000")).toBe(false);
  });

  it("rejects too-short and too-long inputs", () => {
    expect(isValidE164("+123456")).toBe(false); // 6 digits
    expect(isValidE164("+1234567890123456")).toBe(false); // 16 digits
  });

  it("rejects strings with non-digit characters", () => {
    expect(isValidE164("+1-415-555-1212")).toBe(false);
    expect(isValidE164("+1 4155551212")).toBe(false);
    expect(isValidE164("abc12345678")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidE164("")).toBe(false);
  });
});

describe("phoneVariants", () => {
  it("returns an empty list for empty input", () => {
    expect(phoneVariants("")).toEqual([]);
  });

  it("always lists the original number first", () => {
    const out = phoneVariants("37063949836");
    expect(out[0]).toBe("37063949836");
  });

  it("inserts a trunk 0 after each plausible country-code length", () => {
    // Input "37063949836" — CC-1 → "3" + "0" + "7063949836",
    //                       CC-3 → "370" + "0" + "63949836".
    // CC-2 is skipped because "063949836" already starts with 0.
    const out = phoneVariants("37063949836");
    expect(out).toEqual(
      expect.arrayContaining([
        "37063949836",
        "307063949836",
        "370063949836",
      ]),
    );
  });

  it("removes a leading 0 after the country code when present", () => {
    // Input "370063949836" — CC-2 strips one leading 0 from
    // "0063949836" → "37" + "063949836" = "37063949836". Only one zero
    // comes off per pass; that's what the live retry loop needs.
    const out = phoneVariants("370063949836");
    expect(out).toContain("370063949836");
    expect(out).toContain("37063949836");
  });

  it("deduplicates variants that collapse to the same digits", () => {
    const out = phoneVariants("37063949836");
    expect(new Set(out).size).toBe(out.length);
  });

  it("returns just the original when the number is too short for any CC slice", () => {
    // 1-char input is shorter than all ccLen values; both loops skip.
    expect(phoneVariants("1")).toEqual(["1"]);
  });
});

describe("isRecipientNotAllowedError", () => {
  it("matches Meta error code 131030", () => {
    expect(
      isRecipientNotAllowedError(
        "(#131030) Recipient phone number not in allowed list",
      ),
    ).toBe(true);
  });

  it("matches the human-readable English variants", () => {
    expect(isRecipientNotAllowedError("not in allowed list")).toBe(true);
    expect(isRecipientNotAllowedError("recipient not in the allowed list")).toBe(
      true,
    );
    // Case-insensitive on the human text.
    expect(isRecipientNotAllowedError("NOT IN ALLOWED LIST")).toBe(true);
  });

  it("does not false-positive on unrelated Meta errors", () => {
    expect(isRecipientNotAllowedError("(#100) Invalid parameter")).toBe(false);
    expect(isRecipientNotAllowedError("template name does not exist")).toBe(
      false,
    );
    expect(isRecipientNotAllowedError("")).toBe(false);
  });
});

describe("toE164", () => {
  it("keeps an already-canonical number unchanged", () => {
    expect(toE164("+919791766444", "IN")).toBe("+919791766444");
    expect(toE164("+14155550123", "US")).toBe("+14155550123");
  });

  it("adds the missing + to a number that already carries its country code", () => {
    // The WhatsApp webhook's shape: Meta's inbound `from` is digits
    // only, and storing it verbatim is what started the drift.
    expect(toE164("918300070574", "IN")).toBe("+918300070574");
    expect(toE164("919791766444", "IN")).toBe("+919791766444");
  });

  it("adds the default country's code to a bare national number", () => {
    expect(toE164("9791766444", "IN")).toBe("+919791766444");
    expect(toE164("4155550123", "US")).toBe("+14155550123");
  });

  it("resolves the same digits differently per account country", () => {
    // The reason the default is per-account and not global: ten digits
    // are an Indian mobile in one tenant and a US one in another.
    expect(toE164("4155550123", "IN")).toBe("+914155550123");
    expect(toE164("4155550123", "US")).toBe("+14155550123");
  });

  it("drops a domestic trunk prefix", () => {
    expect(toE164("07810032625", "IN")).toBe("+917810032625");
    expect(toE164("00919791766444", "IN")).toBe("+919791766444");
  });

  it("strips punctuation and whitespace", () => {
    expect(toE164("+91 78100 32625", "IN")).toBe("+917810032625");
    expect(toE164("(415) 555-0123", "US")).toBe("+14155550123");
    expect(toE164("  +14155550123  ", "US")).toBe("+14155550123");
  });

  it("prefers a valid foreign reading over the default country", () => {
    // A UK number pasted without its + into an Indian account. Reading
    // it as national-IN would yield +91447911123456, which is why the
    // valid-national check has to run before the possible-national one.
    expect(toE164("447911123456", "IN")).toBe("+447911123456");
  });

  it("returns null for input that is not a phone number", () => {
    expect(toE164("1234", "IN")).toBeNull();
    expect(toE164("abc", "IN")).toBeNull();
    expect(toE164("", "IN")).toBeNull();
    expect(toE164(null, "IN")).toBeNull();
    expect(toE164(undefined, "IN")).toBeNull();
  });

  it("falls back to the international reading when the country is unusable", () => {
    // A stale or malformed setting must not throw inside libphonenumber
    // — it degrades to treating the digits as already-international.
    expect(toE164("918300070574", "")).toBe("+918300070574");
    expect(toE164("918300070574", "91")).toBe("+918300070574");
    expect(toE164("918300070574", null)).toBe("+918300070574");
  });

  it("is idempotent", () => {
    const once = toE164("9791766444", "IN");
    expect(toE164(once, "IN")).toBe(once);
  });

  it("agrees with normalizePhone on the de-dup key", () => {
    // Canonicalizing must not move a contact to a different bucket in
    // the phone_normalized unique index (migration 022).
    for (const raw of ["9791766444", "919791766444", "+91 97917 66444"]) {
      expect(normalizePhone(toE164(raw, "IN")!)).toBe("919791766444");
    }
  });
});

describe("isCanonicalE164", () => {
  it("accepts only the exact stored form", () => {
    expect(isCanonicalE164("+919791766444")).toBe(true);
    // Same invariant as contacts_phone_e164_chk (migration 061).
    expect(isCanonicalE164("919791766444")).toBe(false);
    expect(isCanonicalE164("+0919791766444")).toBe(false);
    expect(isCanonicalE164("+91 97917 66444")).toBe(false);
    expect(isCanonicalE164("")).toBe(false);
  });
});

describe("formatPhoneDisplay", () => {
  it("groups a canonical number for reading", () => {
    expect(formatPhoneDisplay("+919791766444")).toBe("+91 97917 66444");
  });

  it("returns unparseable input unchanged rather than blanking it", () => {
    expect(formatPhoneDisplay("not a number")).toBe("not a number");
    expect(formatPhoneDisplay(null)).toBe("");
  });
});
