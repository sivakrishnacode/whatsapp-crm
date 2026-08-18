"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { OnboardingState } from "@/lib/onboarding/api";

/**
 * The account's billing standing, published from the ONE fetch the
 * onboarding gate already makes on dashboard mount.
 *
 * ⚠️ Deliberately not its own request. `useAuth().subscription` is the
 * *signed-in user's* row, and a teammate of a paid workspace has no row at
 * all — reading it here would show a trial warning to some members of a
 * workspace and not others, on facts that belong to the account. The gate
 * asks `GET /api/onboarding`, which resolves everything through
 * `accounts.owner_user_id`, so every member sees the same truth.
 */
const BillingStandingContext = createContext<OnboardingState | null>(null);

export function BillingStandingProvider({
  state,
  children,
}: {
  state: OnboardingState | null;
  children: ReactNode;
}) {
  return (
    <BillingStandingContext.Provider value={state}>
      {children}
    </BillingStandingContext.Provider>
  );
}

/** Null while the gate is still checking, or if its request failed. */
export function useBillingStanding(): OnboardingState | null {
  return useContext(BillingStandingContext);
}
