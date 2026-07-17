/**
 * Subscription module exports.
 *
 * Only the display-side plan catalog lives in apps/web now — limit checks
 * and usage tracking are enforced server-side in apps/api (SubscriptionService).
 */

export * from './plans';
