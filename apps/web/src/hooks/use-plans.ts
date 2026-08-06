"use client";

import { useEffect, useState } from "react";

import type { OnboardingPlan } from "@/lib/onboarding/api";

/** Same shape the wizard uses — one plan projection across the app. */
export type Plan = OnboardingPlan;

export interface UsePlansReturn {
  plans: Plan[];
  isLoading: boolean;
  error: string | null;
}

/**
 * The selectable plans, from the database.
 *
 * Replaces reading `DEFAULT_PLANS`, which was a second copy of the
 * pricing that drifted the moment anyone edited a price in the admin
 * panel — the pricing page would then quote a number the checkout did
 * not charge. DEFAULT_PLANS survives only as a shape/limits reference.
 *
 * Plain fetch + useState: neither SWR nor React Query is a dependency of
 * this app (see use-tier-status for the same pattern).
 */
export function usePlans(): UsePlansReturn {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    fetch("/api/subscription/plans")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Failed to load plans (${response.status})`);
        return (await response.json()) as { plans: Plan[] };
      })
      .then((body) => {
        if (!active) return;
        setPlans(body.plans);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return { plans, isLoading, error };
}
