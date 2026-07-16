/**
 * Subscription plan definitions and configuration
 */

export type PlanName = 'FREE' | 'STARTER' | 'GROWTH';

export interface SubscriptionPlan {
  id: string;
  name: PlanName;
  display_name: string;
  description: string;
  price_monthly: number;
  price_yearly: number;
  stripe_price_id_monthly: string | null;
  stripe_price_id_yearly: string | null;
  razorpay_plan_id: string | null;
  max_contacts: number;
  max_messages_monthly: number;
  max_broadcasts_monthly: number;
  max_flows: number | null; // null = unlimited
  max_team_members: number;
  max_storage_mb: number;
  trial_days: number | null;
  features: string[];
  is_active: boolean;
}

export interface UserSubscription {
  subscription_id: string;
  plan_id: string;
  plan_name: PlanName;
  plan_display_name: string;
  status: 'active' | 'trial' | 'past_due' | 'cancelled' | 'expired';
  billing_cycle: 'monthly' | 'yearly' | null;
  trial_start_at: string | null;
  trial_end_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  payment_method: 'stripe' | 'razorpay' | 'manual';
  max_contacts: number;
  max_messages_monthly: number;
  max_broadcasts_monthly: number;
  max_flows: number | null;
  max_team_members: number;
  max_storage_mb: number;
  trial_days: number | null;
  features: string[];
}

export type LimitType = 'contacts' | 'messages' | 'broadcasts' | 'flows' | 'team_members' | 'storage';

export interface LimitCheckResult {
  allowed: boolean;
  current_usage: number;
  limit_value: number | null;
  reason: string;
}

/**
 * Default plan limits (fallback if database is unavailable)
 */
export const DEFAULT_PLANS: Record<PlanName, Omit<SubscriptionPlan, 'id'>> = {
  FREE: {
    name: 'FREE',
    display_name: 'Free',
    description: 'Perfect for getting started with WhatsApp CRM',
    price_monthly: 0,
    price_yearly: 0,
    stripe_price_id_monthly: null,
    stripe_price_id_yearly: null,
    razorpay_plan_id: null,
    max_contacts: 100,
    max_messages_monthly: 500,
    max_broadcasts_monthly: 5,
    max_flows: 3,
    max_team_members: 1,
    max_storage_mb: 100,
    trial_days: null,
    features: ['100 contacts', '500 messages/month', '5 broadcasts/month', '3 flows', '1 team member', '100MB storage'],
    is_active: true,
  },
  STARTER: {
    name: 'STARTER',
    display_name: 'Starter',
    description: 'For growing businesses with more automation needs',
    price_monthly: 300,
    price_yearly: 3000,
    stripe_price_id_monthly: null,
    stripe_price_id_yearly: null,
    razorpay_plan_id: null,
    max_contacts: 1000,
    max_messages_monthly: 5000,
    max_broadcasts_monthly: 25,
    max_flows: 10,
    max_team_members: 3,
    max_storage_mb: 1024,
    trial_days: 15,
    features: ['1,000 contacts', '5,000 messages/month', '25 broadcasts/month', '10 flows', '3 team members', '1GB storage', 'Priority support'],
    is_active: true,
  },
  GROWTH: {
    name: 'GROWTH',
    display_name: 'Growth',
    description: 'For scaling teams with advanced automation',
    price_monthly: 500,
    price_yearly: 5000,
    stripe_price_id_monthly: null,
    stripe_price_id_yearly: null,
    razorpay_plan_id: null,
    max_contacts: 10000,
    max_messages_monthly: 50000,
    max_broadcasts_monthly: 100,
    max_flows: null, // unlimited
    max_team_members: 10,
    max_storage_mb: 10240,
    trial_days: 15,
    features: ['10,000 contacts', '50,000 messages/month', '100 broadcasts/month', 'Unlimited flows', '10 team members', '10GB storage', 'Priority support', 'Advanced analytics'],
    is_active: true,
  },
};

/**
 * Get plan by name
 */
export function getPlanByName(name: PlanName): Omit<SubscriptionPlan, 'id'> {
  return DEFAULT_PLANS[name];
}

/**
 * Check if a plan has unlimited limit for a given type
 */
export function isUnlimited(plan: SubscriptionPlan, type: LimitType): boolean {
  switch (type) {
    case 'flows':
      return plan.max_flows === null;
    default:
      return false;
  }
}

/**
 * Format limit for display (e.g., "100", "Unlimited")
 */
export function formatLimit(value: number | null): string {
  if (value === null) return 'Unlimited';
  return value.toLocaleString();
}

/**
 * Get human-readable limit type name
 */
export function getLimitTypeName(type: LimitType): string {
  const names: Record<LimitType, string> = {
    contacts: 'Contacts',
    messages: 'Messages per month',
    broadcasts: 'Broadcasts per month',
    flows: 'Flows',
    team_members: 'Team members',
    storage: 'Storage (MB)',
  };
  return names[type];
}
