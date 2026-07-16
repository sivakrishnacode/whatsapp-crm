/**
 * Subscription limit checking functions
 */

import { createClient } from '@/lib/supabase/client';
import type { LimitType, LimitCheckResult } from './plans';

/**
 * Check if user can perform an action based on their subscription limits
 */
export async function checkSubscriptionLimit(
  userId: string,
  limitType: LimitType,
  increment: number = 1
): Promise<LimitCheckResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('check_subscription_limit', {
    p_user_id: userId,
    p_limit_type: limitType,
    p_increment: increment,
  });

  if (error) {
    console.error('[checkSubscriptionLimit] Error:', error);
    return {
      allowed: false,
      current_usage: 0,
      limit_value: 0,
      reason: 'Error checking subscription limit',
    };
  }

  if (!data || data.length === 0) {
    return {
      allowed: false,
      current_usage: 0,
      limit_value: 0,
      reason: 'No subscription found',
    };
  }

  return data[0] as LimitCheckResult;
}

/**
 * Check if user can create a contact
 */
export async function canCreateContact(userId: string): Promise<LimitCheckResult> {
  return checkSubscriptionLimit(userId, 'contacts', 1);
}

/**
 * Check if user can send a message
 */
export async function canSendMessage(userId: string): Promise<LimitCheckResult> {
  return checkSubscriptionLimit(userId, 'messages', 1);
}

/**
 * Check if user can create a broadcast
 */
export async function canCreateBroadcast(userId: string): Promise<LimitCheckResult> {
  return checkSubscriptionLimit(userId, 'broadcasts', 1);
}

/**
 * Check if user can create a flow
 */
export async function canCreateFlow(userId: string): Promise<LimitCheckResult> {
  return checkSubscriptionLimit(userId, 'flows', 1);
}

/**
 * Check if user can add a team member
 */
export async function canAddTeamMember(userId: string): Promise<LimitCheckResult> {
  return checkSubscriptionLimit(userId, 'team_members', 1);
}

/**
 * Check if user can upload storage
 */
export async function canUseStorage(userId: string, sizeMb: number): Promise<LimitCheckResult> {
  return checkSubscriptionLimit(userId, 'storage', sizeMb);
}

/**
 * Throw error if limit is exceeded (for use in API routes)
 */
export async function enforceLimit(
  userId: string,
  limitType: LimitType,
  increment: number = 1
): Promise<void> {
  const result = await checkSubscriptionLimit(userId, limitType, increment);

  if (!result.allowed) {
    throw new SubscriptionLimitError(
      limitType,
      result.current_usage,
      result.limit_value,
      result.reason
    );
  }
}

/**
 * Custom error for subscription limit violations
 */
export class SubscriptionLimitError extends Error {
  constructor(
    public limitType: LimitType,
    public currentUsage: number,
    public limitValue: number | null,
    reason: string
  ) {
    super(reason);
    this.name = 'SubscriptionLimitError';
  }

  /**
   * Get user-friendly error message
   */
  getUserMessage(): string {
    const limitDisplay = this.limitValue === null ? 'Unlimited' : this.limitValue.toLocaleString();
    
    const typeNames: Record<LimitType, string> = {
      contacts: 'contacts',
      messages: 'messages per month',
      broadcasts: 'broadcasts per month',
      flows: 'flows',
      team_members: 'team members',
      storage: 'storage',
    };

    return `You have reached your ${typeNames[this.limitType]} limit (${this.currentUsage}/${limitDisplay}). Please upgrade your plan to continue.`;
  }
}
