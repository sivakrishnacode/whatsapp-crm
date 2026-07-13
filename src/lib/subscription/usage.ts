/**
 * Usage tracking functions
 */

import { createClient } from '@/lib/supabase/client';

export type UsageType = 'contacts' | 'messages' | 'broadcasts' | 'flows' | 'storage';

/**
 * Increment usage counter for a user
 */
export async function incrementUsage(
  userId: string,
  type: UsageType,
  increment: number = 1
): Promise<boolean> {
  const supabase = createClient();

  const { error } = await supabase.rpc('increment_usage', {
    p_user_id: userId,
    p_type: type,
    p_increment: increment,
  });

  if (error) {
    console.error('[incrementUsage] Error:', error);
    return false;
  }

  return true;
}

/**
 * Decrement usage counter for a user
 */
export async function decrementUsage(
  userId: string,
  type: UsageType,
  decrement: number = 1
): Promise<boolean> {
  const supabase = createClient();

  const { error } = await supabase.rpc('decrement_usage', {
    p_user_id: userId,
    p_type: type,
    p_decrement: decrement,
  });

  if (error) {
    console.error('[decrementUsage] Error:', error);
    return false;
  }

  return true;
}

/**
 * Get current usage for a user
 */
export async function getCurrentUsage(userId: string) {
  const supabase = createClient();
  const currentMonthStart = new Date();
  currentMonthStart.setDate(1);
  currentMonthStart.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('usage_tracking')
    .select('*')
    .eq('user_id', userId)
    .gte('period_start', currentMonthStart.toISOString())
    .maybeSingle();

  if (error) {
    console.error('[getCurrentUsage] Error:', error);
    return null;
  }

  return data;
}

/**
 * Reset monthly usage counters (called by cron job)
 */
export async function resetMonthlyUsage(): Promise<void> {
  const supabase = createClient();

  const { error } = await supabase.rpc('reset_monthly_usage');

  if (error) {
    console.error('[resetMonthlyUsage] Error:', error);
  }
}

/**
 * Track contact creation
 */
export async function trackContactCreated(userId: string): Promise<boolean> {
  return incrementUsage(userId, 'contacts', 1);
}

/**
 * Track contact deletion
 */
export async function trackContactDeleted(userId: string): Promise<boolean> {
  return decrementUsage(userId, 'contacts', 1);
}

/**
 * Track message sent
 */
export async function trackMessageSent(userId: string): Promise<boolean> {
  return incrementUsage(userId, 'messages', 1);
}

/**
 * Track broadcast sent
 */
export async function trackBroadcastSent(userId: string): Promise<boolean> {
  return incrementUsage(userId, 'broadcasts', 1);
}

/**
 * Track flow created
 */
export async function trackFlowCreated(userId: string): Promise<boolean> {
  return incrementUsage(userId, 'flows', 1);
}

/**
 * Track flow deleted
 */
export async function trackFlowDeleted(userId: string): Promise<boolean> {
  return decrementUsage(userId, 'flows', 1);
}

/**
 * Track storage used
 */
export async function trackStorageUsed(userId: string, sizeMb: number): Promise<boolean> {
  return incrementUsage(userId, 'storage', sizeMb);
}

/**
 * Track storage freed
 */
export async function trackStorageFreed(userId: string, sizeMb: number): Promise<boolean> {
  return decrementUsage(userId, 'storage', sizeMb);
}
