/**
 * Admin functions for manual subscription management
 */

import { createClient } from '@/lib/supabase/client';
import type { PlanName } from './plans';

/**
 * Manually assign a plan to a user (admin-only)
 */
export async function assignPlanToUser(
  adminUserId: string,
  targetUserId: string,
  planName: PlanName
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();

  try {
    // Verify admin has permission (admin or owner role)
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('account_role')
      .eq('user_id', adminUserId)
      .single();

    if (!adminProfile || (adminProfile.account_role !== 'admin' && adminProfile.account_role !== 'owner')) {
      return { success: false, error: 'Insufficient permissions' };
    }

    // Get plan ID
    const { data: plan } = await supabase
      .from('subscription_plans')
      .select('id, trial_days')
      .eq('name', planName)
      .single();

    if (!plan) {
      return { success: false, error: 'Plan not found' };
    }

    // Calculate trial period for paid plans
    const trialStart = plan.trial_days ? new Date() : null;
    const trialEnd = plan.trial_days 
      ? new Date(Date.now() + plan.trial_days * 24 * 60 * 60 * 1000) 
      : null;

    // Update or create user subscription
    const { error: upsertError } = await supabase
      .from('user_subscriptions')
      .upsert({
        user_id: targetUserId,
        plan_id: plan.id,
        status: trialEnd ? 'trial' : 'active',
        billing_cycle: planName === 'FREE' ? null : 'monthly',
        trial_start_at: trialStart?.toISOString(),
        trial_end_at: trialEnd?.toISOString(),
        current_period_start: trialStart?.toISOString() || new Date().toISOString(),
        current_period_end: trialEnd?.toISOString() || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        cancel_at_period_end: false,
        stripe_subscription_id: null,
        razorpay_subscription_id: null,
        payment_method: 'manual',
        manually_assigned_by: adminUserId,
      }, {
        onConflict: 'user_id',
      });

    if (upsertError) {
      console.error('[assignPlanToUser] Error upserting subscription:', upsertError);
      return { success: false, error: upsertError.message };
    }

    return { success: true };
  } catch (error) {
    console.error('[assignPlanToUser] Error:', error);
    return { success: false, error: 'Internal server error' };
  }
}

/**
 * Get all users with their subscriptions (admin-only)
 */
export async function getAllUsersWithSubscriptions(
  adminUserId: string
): Promise<{ success: boolean; data?: any[]; error?: string }> {
  const supabase = createClient();

  try {
    // Verify admin has permission
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('account_role')
      .eq('user_id', adminUserId)
      .single();

    if (!adminProfile || (adminProfile.account_role !== 'admin' && adminProfile.account_role !== 'owner')) {
      return { success: false, error: 'Insufficient permissions' };
    }

    // Get all users
    const { data: users, error: usersError } = await supabase
      .from('profiles')
      .select('id, user_id, email, full_name, created_at')
      .order('created_at', { ascending: false });

    if (usersError) throw usersError;

    // Fetch subscriptions for each user
    const usersWithSubs = await Promise.all(
      (users || []).map(async (profile) => {
        const { data: subData } = await supabase
          .rpc('get_user_subscription', { p_user_id: profile.user_id });

        return {
          ...profile,
          subscription: subData && subData.length > 0 ? subData[0] : null,
        };
      })
    );

    return { success: true, data: usersWithSubs };
  } catch (error) {
    console.error('[getAllUsersWithSubscriptions] Error:', error);
    return { success: false, error: 'Internal server error' };
  }
}

/**
 * Cancel user subscription and downgrade to FREE (admin-only)
 */
export async function cancelUserSubscription(
  adminUserId: string,
  targetUserId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();

  try {
    // Verify admin has permission
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('account_role')
      .eq('user_id', adminUserId)
      .single();

    if (!adminProfile || (adminProfile.account_role !== 'admin' && adminProfile.account_role !== 'owner')) {
      return { success: false, error: 'Insufficient permissions' };
    }

    // Get FREE plan ID
    const { data: freePlan } = await supabase
      .from('subscription_plans')
      .select('id')
      .eq('name', 'FREE')
      .single();

    if (!freePlan) {
      return { success: false, error: 'FREE plan not found' };
    }

    // Update subscription to FREE
    const { error: updateError } = await supabase
      .from('user_subscriptions')
      .update({
        plan_id: freePlan.id,
        status: 'active',
        billing_cycle: null,
        trial_start_at: null,
        trial_end_at: null,
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
        stripe_subscription_id: null,
        razorpay_subscription_id: null,
        payment_method: 'manual',
        manually_assigned_by: adminUserId,
      })
      .eq('user_id', targetUserId);

    if (updateError) {
      console.error('[cancelUserSubscription] Error:', updateError);
      return { success: false, error: updateError.message };
    }

    return { success: true };
  } catch (error) {
    console.error('[cancelUserSubscription] Error:', error);
    return { success: false, error: 'Internal server error' };
  }
}
