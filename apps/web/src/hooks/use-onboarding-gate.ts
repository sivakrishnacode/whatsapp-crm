"use client";

import { useEffect, useState } from "react";

import { fetchOnboardingState } from "@/lib/onboarding/api";

export type OnboardingGateStatus = "checking" | "required" | "allowed";

/**
 * The hard gate in front of the dashboard.
 *
 * WHY IT ASKS THE API RATHER THAN READING SUPABASE DIRECTLY
 *   "Has this workspace onboarded?" is two facts: the account finished
 *   the wizard, and its OWNER holds an active-or-trial subscription.
 *   `useAuth().subscription` is the *current user's* row, so a member of
 *   a paid workspace looks unsubscribed through it and would be gated
 *   out of an account that has paid. `GET /api/onboarding` resolves both
 *   facts account-side, in the one place that rule lives.
 *
 * WHY IT IS NOT IN MIDDLEWARE
 *   Middleware runs on every request and today makes exactly one
 *   network call. Adding a database read there would put a round trip in
 *   front of every navigation and every asset request that matches the
 *   matcher, to answer a question that changes twice in an account's
 *   lifetime.
 *
 * FAILURE IS OPEN, ON PURPOSE
 *   If the check itself errors (API down, network blip) the status
 *   resolves to "allowed". A billing gate that locks paying customers
 *   out of their inbox whenever the onboarding endpoint hiccups is worse
 *   than one that occasionally lets an un-onboarded account through —
 *   they hit the plan limits regardless.
 */
export function useOnboardingGate(enabled: boolean): OnboardingGateStatus {
  const [status, setStatus] = useState<OnboardingGateStatus>("checking");

  useEffect(() => {
    if (!enabled) return;

    let active = true;

    fetchOnboardingState()
      .then((state) => {
        if (!active) return;
        setStatus(state.step === "done" ? "allowed" : "required");
      })
      .catch((error) => {
        console.error("[useOnboardingGate] check failed:", error);
        if (active) setStatus("allowed");
      });

    return () => {
      active = false;
    };
  }, [enabled]);

  return status;
}
