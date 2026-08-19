import type { PrismaClient } from '@prisma/client';

/**
 * The workspace a paying user's subscription belongs to.
 *
 * ⚠️ PHASE 1 ONLY, AND THAT IS THE POINT OF THIS FILE EXISTING.
 *
 * Billing is still keyed by user: `user_subscriptions.user_id` is UNIQUE and
 * `OnboardingService` always writes the row for `accounts.owner_user_id`. So
 * "which workspace did this payment buy" is answered by "which workspace does
 * this user own" — and `idx_accounts_one_per_owner` still guarantees that is at
 * most one, which is exactly why phase 1 does not yet allow anyone to create a
 * second workspace.
 *
 * These four call sites previously asked `profiles.account_id`, which happened
 * to give the same answer while a user had exactly one workspace and no longer
 * exists. Resolving through ownership is both correct now and the thing phase 2
 * replaces: when `user_subscriptions` gains `account_id UNIQUE` and `user_id`
 * becomes the payer, every caller of this helper reads the column directly and
 * this file is deleted.
 *
 * Returns null when the user owns no workspace — a webhook for a payer who has
 * since been transferred out of ownership. Callers must treat that as "nothing
 * to stamp", never as an error worth failing the webhook over: Razorpay and
 * Stripe retry non-2xx, and a retry loop does not conjure a workspace.
 */
export async function ownedAccountId(
  prisma: Pick<PrismaClient, 'account'>,
  userId: string,
): Promise<string | null> {
  const account = await prisma.account.findUnique({
    where: { ownerUserId: userId },
    select: { id: true },
  });
  return account?.id ?? null;
}
