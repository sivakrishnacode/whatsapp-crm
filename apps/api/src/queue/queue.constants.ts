/**
 * Every BullMQ queue name in the API, in one place.
 *
 * Two reasons this file exists rather than a `const` next to each
 * processor:
 *
 * 1. A queue name is a Redis key. A typo between the producer and the
 *    consumer is not a compile error — it is a job that is enqueued
 *    successfully and never runs. Importing the same symbol on both
 *    sides makes that impossible.
 * 2. The Bull Board dashboard has to enumerate the queues it shows.
 *    Without a central list, a new queue is invisible in the dashboard
 *    until someone remembers to add it there too — which is exactly
 *    when you need to see it.
 *
 * Names are kebab-case and stable: renaming one strands every job
 * already in Redis under the old key, so treat these as data, not code.
 */

/* ---------------------------------------------------------------- *
 * Broadcasts — fan-out delivery
 * ---------------------------------------------------------------- */

/** One job per broadcast. Fans out into BROADCAST_SEND_QUEUE. */
export const BROADCAST_ORCHESTRATE_QUEUE = 'broadcast-orchestrate';

/** One job per recipient. Rate-limited; this is where Meta is called. */
export const BROADCAST_SEND_QUEUE = 'broadcast-send';

/* ---------------------------------------------------------------- *
 * Outbound integrations
 * ---------------------------------------------------------------- */

/** One job per (event, endpoint) pair for the public-API webhooks. */
export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';

/** Inbound message → AI auto-reply. One job per inbound message. */
export const AI_REPLY_QUEUE = 'ai-reply';

/** Trigger fan-out into the automation engine. One job per event. */
export const AUTOMATION_TRIGGER_QUEUE = 'automation-trigger';

/** A full product/order import from a connected store. */
export const ECOMMERCE_SYNC_QUEUE = 'ecommerce-sync';

/** Fetching one lead's answers from Meta after a leadgen webhook. */
export const LEAD_FETCH_QUEUE = 'lead-fetch';

/* ---------------------------------------------------------------- *
 * Pre-existing queues — declared here so the dashboard sees them.
 * The owning module still registers and processes them.
 * ---------------------------------------------------------------- */

/** Automation runs parked at a wait step (delayed jobs). */
export const AUTOMATIONS_PENDING_QUEUE = 'automations-pending';

/**
 * Periodic scan that times out abandoned flow runs — and, since
 * migration 086, continues any run whose `wait` came due while Redis
 * was not around to fire the delayed job.
 */
export const FLOWS_SWEEP_QUEUE = 'flows-sweep';

/**
 * One delayed job per run parked at a `wait` node.
 *
 * Per-row delayed jobs (unlike the sweep, which is a periodic scan)
 * because a wait's due time is fixed the moment the node runs — there
 * is no policy to edit afterwards that would make a pre-scheduled job
 * go stale. The row still carries `resume_at`, so a lost Redis degrades
 * to "the sweep picks it up" rather than "the customer is stranded".
 */
export const FLOWS_RESUME_QUEUE = 'flows-resume';

/** Nightly refresh of WhatsApp messaging limits / quality rating. */
export const LIMITS_QUEUE = 'whatsapp-limits';

/** Instagram long-lived token refresh. */
export const IG_TOKEN_QUEUE = 'instagram-token-refresh';

/** Delayed replies for Instagram comment funnels. */
export const IG_FUNNEL_QUEUE = 'ig-comment-funnel';

/** Nightly + on-demand Meta Ads insights sync. */
export const ADS_SYNC_QUEUE = 'ads-sync';

/**
 * Hourly pass that expires lapsed trials and flags unbacked
 * subscriptions past their period end. Nothing else ever moved a
 * subscription out of `trial`.
 */
export const SUBSCRIPTION_SWEEP_QUEUE = 'subscription-sweep';

/**
 * The dashboard's queue list, in the order it should be displayed:
 * the paths that carry customer messages first, housekeeping last.
 *
 * Add every new queue here. A queue missing from this array still
 * works — it is simply invisible at /admin/queues.
 */
export const ALL_QUEUE_NAMES = [
  BROADCAST_ORCHESTRATE_QUEUE,
  BROADCAST_SEND_QUEUE,
  AI_REPLY_QUEUE,
  AUTOMATION_TRIGGER_QUEUE,
  AUTOMATIONS_PENDING_QUEUE,
  FLOWS_RESUME_QUEUE,
  FLOWS_SWEEP_QUEUE,
  WEBHOOK_DELIVERY_QUEUE,
  LEAD_FETCH_QUEUE,
  ECOMMERCE_SYNC_QUEUE,
  ADS_SYNC_QUEUE,
  SUBSCRIPTION_SWEEP_QUEUE,
  LIMITS_QUEUE,
  IG_TOKEN_QUEUE,
  IG_FUNNEL_QUEUE,
] as const;

export type QueueName = (typeof ALL_QUEUE_NAMES)[number];

/**
 * Read a positive integer from the environment, falling back when it is
 * unset, unparseable or nonsensical. Queue tuning is the sort of thing
 * that gets set hastily during an incident, and a typo'd
 * `BROADCAST_SEND_CONCURRENCY=1O` must not silently become NaN
 * concurrency.
 */
export function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/**
 * Per-second send ceiling for broadcast recipients.
 *
 * ⚠️ This is a *global* limiter, not per phone number. BullMQ's
 * open-source limiter is per queue; grouped (per-key) rate limiting is a
 * BullMQ Pro feature. So a single very large broadcast does slow other
 * accounts' broadcasts down — the trade we accept in exchange for never
 * exceeding Meta's per-number rate on any one account.
 *
 * Default 10/s = Meta's Tier 1 ceiling, the tier every new WABA starts
 * on. Raise it once an account is verified at a higher tier.
 */
export const BROADCAST_SEND_RATE_MAX = envInt('BROADCAST_SEND_RATE_MAX', 10);
export const BROADCAST_SEND_RATE_DURATION_MS = envInt(
  'BROADCAST_SEND_RATE_DURATION_MS',
  1000,
);

/**
 * How many recipient jobs run at once. Above the rate limiter this
 * changes nothing except how quickly the limiter's budget is consumed;
 * below it, it is the real cap.
 */
export const BROADCAST_SEND_CONCURRENCY = envInt(
  'BROADCAST_SEND_CONCURRENCY',
  10,
);

/**
 * How many AI auto-replies may be generated at once.
 *
 * ⚠️ This number is the auto-reply bot's response time. Before the
 * queue, every inbound message started its own provider call
 * immediately, with no ceiling — so anything that makes a reply *wait*
 * for a free slot is a regression the customer feels directly, in the
 * one place where being slow looks most like being broken.
 *
 * 20 is therefore deliberately generous: these jobs are almost entirely
 * idle time waiting on the provider (a few hundred ms to a few
 * seconds), not CPU, and each account pays for its own tokens with its
 * own key. Pickup off the queue itself costs about a millisecond —
 * BullMQ workers block on Redis rather than polling — so with a free
 * slot the queue adds no perceptible latency at all.
 *
 * Raise it if a busy deployment ever shows a waiting count above zero
 * on the ai-reply queue at /admin/queues; that is the signal, and it is
 * the only thing that would make replies slower than they used to be.
 */
export const AI_REPLY_CONCURRENCY = envInt('AI_REPLY_CONCURRENCY', 20);

/**
 * Standard retry policy for a job that calls somebody else's HTTP API.
 *
 * `removeOnFail: { count: N }` rather than `true` on purpose: a failed
 * job is the only durable record of *why* a delivery never happened, and
 * "it silently didn't arrive" is the single hardest support question to
 * answer. Keeping the last N failures per queue makes /admin/queues
 * useful after the fact, at a bounded memory cost.
 */
export const EXTERNAL_CALL_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 3000 },
  removeOnComplete: { count: 100, age: 24 * 3600 },
  removeOnFail: { count: 500 },
};
