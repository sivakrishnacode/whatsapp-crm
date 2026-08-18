/**
 * What, if anything, to say about an account's billing standing.
 *
 * Pure and separate from the banner that renders it, because the two
 * things worth getting right here are decisions rather than markup: how
 * many days count as "soon", and the fact that `past_due` must NOT read as
 * the end of the road.
 */

/** Show the countdown only once it is close enough to act on. */
export const WARN_WITHIN_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BillingNotice {
  kind: "trial" | "past_due";
  headline: string;
  detail: string;
  cta: string;
}

export interface NoticeSubscription {
  status: string;
  trialEndsAt: string | null;
  planDisplayName: string;
}

export function resolveBillingNotice(
  subscription: NoticeSubscription | null | undefined,
  now: Date = new Date(),
): BillingNotice | null {
  if (!subscription) return null;

  /**
   * Dunning, not death. `get_account_entitlement` grades `past_due` as
   * `grace` and still allows writes, and the subscription sweep sets it
   * without a human involved — so the honest message is "this still
   * works, but fix it", never a lockout warning.
   */
  if (subscription.status === "past_due") {
    return {
      kind: "past_due",
      headline: "We could not take your last payment.",
      detail:
        "Your workspace still works for now — update your payment method to keep it that way.",
      cta: "Fix payment",
    };
  }

  if (subscription.status !== "trial" || !subscription.trialEndsAt) return null;

  const endsAt = new Date(subscription.trialEndsAt);
  if (Number.isNaN(endsAt.getTime())) return null;

  // Ceil, so the last part-day reads "1 day left" rather than "0 days
  // left" while the trial is genuinely still running.
  const daysLeft = Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS);

  if (daysLeft > WARN_WITHIN_DAYS) return null;
  // Already over. The gate is about to move them to /billing, and an
  // expired trial is not a countdown.
  if (daysLeft <= 0) return null;

  return {
    kind: "trial",
    headline:
      daysLeft === 1
        ? "Your free trial ends tomorrow."
        : `Your free trial ends in ${daysLeft} days.`,
    detail: `Add a payment method to stay on ${subscription.planDisplayName}.`,
    cta: "Choose a plan",
  };
}
