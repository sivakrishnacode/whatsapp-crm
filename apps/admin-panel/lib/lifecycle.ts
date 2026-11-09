/**
 * Client lifecycle (C360-022) — derived, with an optional operator override.
 *
 * Pure. The stage is computed from facts the product already records, so it
 * can never drift from them; the only stored thing is an operator's explicit
 * pin (`client_accounts.lifecycle_override`) and its reason.
 *
 * ⚠️ A stage is a CLASSIFICATION for the portfolio, not an enforcement.
 * Pinning "suspended" does not stop a workspace sending messages — access is
 * governed by its subscription (get_account_entitlement), and the panel says
 * so wherever a stage can be pinned.
 */

import type { HealthState } from '@/lib/health/rules';

export const LIFECYCLE_STAGES = [
  'lead',
  'onboarding',
  'active',
  'attention',
  'suspended',
  'churned',
  'archived',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export function isLifecycleStage(value: unknown): value is LifecycleStage {
  return (
    typeof value === 'string' &&
    (LIFECYCLE_STAGES as readonly string[]).includes(value)
  );
}

export type LifecycleInput = {
  override: string | null;
  subscriptionStatus:
    'active' | 'trial' | 'past_due' | 'cancelled' | 'expired' | null;
  onboardingCompleted: boolean;
  /** Any of WhatsApp / Instagram / web live. */
  channelLive: boolean;
  health: HealthState;
};

export function deriveLifecycle(input: LifecycleInput): {
  stage: LifecycleStage;
  pinned: boolean;
  /** Why the derived stage is what it is — shown on hover / in the 360. */
  because: string;
} {
  if (isLifecycleStage(input.override)) {
    return {
      stage: input.override,
      pinned: true,
      because: 'Pinned by an operator.',
    };
  }
  if (
    input.subscriptionStatus === 'cancelled' ||
    input.subscriptionStatus === 'expired'
  ) {
    return {
      stage: 'churned',
      pinned: false,
      because: `Subscription is ${input.subscriptionStatus}.`,
    };
  }
  if (!input.onboardingCompleted) {
    return {
      stage: 'onboarding',
      pinned: false,
      because: 'The welcome wizard is not finished.',
    };
  }
  if (!input.channelLive) {
    return {
      stage: 'onboarding',
      pinned: false,
      because: 'No channel is connected yet.',
    };
  }
  if (input.health === 'critical' || input.subscriptionStatus === 'past_due') {
    return {
      stage: 'attention',
      pinned: false,
      because:
        input.subscriptionStatus === 'past_due'
          ? 'Payment is past due.'
          : 'A health check is critical.',
    };
  }
  return {
    stage: 'active',
    pinned: false,
    because: 'Onboarded, a channel is live, and nothing is critical.',
  };
}
