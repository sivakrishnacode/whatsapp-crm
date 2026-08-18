"use client";

import { useEffect, useState } from "react";

import { fetchOnboardingState, type OnboardingState } from "@/lib/onboarding/api";

export type OnboardingGateStatus = "checking" | "required" | "allowed";

export interface OnboardingGate {
  status: OnboardingGateStatus;
  /**
   * The whole state, kept rather than thrown away, for two reasons: the
   * redirect target depends on WHICH step is outstanding, and the trial
   * notice banner needs the same facts this fetch already carries. A
   * second request for them would be a second answer that could disagree.
   */
  state: OnboardingState | null;
  /** Where to send them, or null when they may stay. */
  redirectTo: string | null;
}

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
 *
 * ⚠️ TWO DESTINATIONS, NOT ONE
 *   Every outstanding step used to redirect to `/welcome`. For a lapsed
 *   account that was a dead end: the wizard offered a free trial the
 *   server would refuse to grant, and `/pricing` — the only screen that
 *   takes payment — is itself inside this gate, so it was unreachable
 *   precisely when it was needed. `step === 'billing'` now goes to
 *   `/billing` instead.
 */
export function useOnboardingGate(enabled: boolean): OnboardingGate {
  const [status, setStatus] = useState<OnboardingGateStatus>("checking");
  const [state, setState] = useState<OnboardingState | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let active = true;

    fetchOnboardingState()
      .then((next) => {
        if (!active) return;
        setState(next);
        setStatus(next.step === "done" ? "allowed" : "required");
      })
      .catch((error) => {
        console.error("[useOnboardingGate] check failed:", error);
        if (active) setStatus("allowed");
      });

    return () => {
      active = false;
    };
  }, [enabled]);

  return {
    status,
    state,
    redirectTo:
      status !== "required"
        ? null
        : state?.step === "billing"
          ? "/billing"
          : "/welcome",
  };
}
