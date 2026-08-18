import { describe, expect, it } from "vitest";

import { resolveBillingNotice } from "./notice";

const NOW = new Date("2026-08-18T10:00:00Z");

function trial(trialEndsAt: string | null, status = "trial") {
  return { status, trialEndsAt, planDisplayName: "Starter" };
}

describe("resolveBillingNotice", () => {
  it("says nothing while the trial has plenty of time left", () => {
    expect(resolveBillingNotice(trial("2026-09-01T10:00:00Z"), NOW)).toBeNull();
  });

  it("counts down inside the warning window", () => {
    const notice = resolveBillingNotice(trial("2026-08-21T10:00:00Z"), NOW);

    expect(notice?.kind).toBe("trial");
    expect(notice?.headline).toBe("Your free trial ends in 3 days.");
    expect(notice?.detail).toContain("Starter");
  });

  /** "1 day" reads as a deadline; "tomorrow" reads as urgent. */
  it("says tomorrow on the last day", () => {
    const notice = resolveBillingNotice(trial("2026-08-19T09:00:00Z"), NOW);

    expect(notice?.headline).toBe("Your free trial ends tomorrow.");
  });

  /**
   * A part-day left is still a day the customer can use, so it must not
   * round down to "0 days" — the reason the maths ceils.
   */
  it("treats a few hours left as one day, not zero", () => {
    const notice = resolveBillingNotice(trial("2026-08-18T22:00:00Z"), NOW);

    expect(notice?.headline).toBe("Your free trial ends tomorrow.");
  });

  /**
   * Past the end there is nothing to count down to: the gate is already
   * moving them to /billing, and "ends in -2 days" is nonsense.
   */
  it("stops counting once the trial has ended", () => {
    expect(resolveBillingNotice(trial("2026-08-16T10:00:00Z"), NOW)).toBeNull();
  });

  /**
   * ⚠️ `past_due` is dunning, and `get_account_entitlement` grades it
   * `grace` — writes still work and the account keeps the product. The
   * message has to say that, or a customer whose card merely bounced will
   * read it as being locked out and stop working.
   */
  it("warns about a failed payment without claiming the workspace is closed", () => {
    const notice = resolveBillingNotice(trial(null, "past_due"), NOW);

    expect(notice?.kind).toBe("past_due");
    expect(notice?.detail).toContain("still works");
  });

  it("says nothing for a healthy paid account", () => {
    expect(resolveBillingNotice(trial(null, "active"), NOW)).toBeNull();
  });

  it("says nothing when there is no subscription to describe", () => {
    expect(resolveBillingNotice(null, NOW)).toBeNull();
    expect(resolveBillingNotice(undefined, NOW)).toBeNull();
  });

  /** A trial with no end date cannot be counted down; don't invent one. */
  it("ignores a trial with no end date, and an unparseable one", () => {
    expect(resolveBillingNotice(trial(null), NOW)).toBeNull();
    expect(resolveBillingNotice(trial("not-a-date"), NOW)).toBeNull();
  });
});
