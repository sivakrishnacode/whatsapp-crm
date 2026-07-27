/**
 * Parsing for Meta's messaging-limit / quality webhook pushes.
 *
 * WHY BOTH FIELDS ARE HANDLED
 * Meta splits this information across two change fields, and their
 * payload shapes are not consistently documented:
 *
 *   phone_number_quality_update — quality rating changes; historically
 *     also carries `current_limit` (the tier string).
 *   business_capability_update  — carries `max_daily_conversation_per_phone`
 *     (a NUMBER, not a tier string).
 *
 * The vendored Meta collection (notes/WhatsApp Cloud API.postman_collection.json)
 * documents neither webhook, so rather than betting on one shape we
 * accept both fields and read whichever keys are actually present. An
 * unrecognised payload is a no-op, never an error.
 */

/** Meta's tier strings -> messages per rolling 24h window. */
const TIER_FROM_LIMIT: Record<number, string> = {
  250: 'TIER_250',
  1000: 'TIER_1K',
  10000: 'TIER_10K',
  100000: 'TIER_100K',
};

const QUALITY_RATINGS = new Set(['GREEN', 'YELLOW', 'RED', 'NA']);

const LIMIT_WEBHOOK_FIELDS = new Set([
  'business_capability_update',
  'phone_number_quality_update',
]);

export function isLimitWebhookField(field: string): boolean {
  return LIMIT_WEBHOOK_FIELDS.has(field);
}

export interface LimitWebhookValue {
  /** Tier string, e.g. "TIER_1K". */
  current_limit?: string;
  /** Numeric daily conversation cap. */
  max_daily_conversation_per_phone?: number | string;
  /** On a quality update: FLAGGED / UNFLAGGED / ONBOARDING, or a rating. */
  event?: string;
  current_quality_rating?: string;
  quality_rating?: string;
  display_phone_number?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
}

export interface ParsedLimitUpdate {
  /** Raw tier string, if the payload carried one (directly or via a mappable number). */
  tier: string | null;
  /** Quality rating, if the payload carried one. */
  qualityRating: string | null;
  phoneNumberId: string | null;
}

/**
 * Pull whatever tier / quality information a limit webhook contains.
 * Returns nulls for anything absent; the caller writes only what's set.
 */
export function parseLimitWebhookValue(
  value: LimitWebhookValue | undefined,
): ParsedLimitUpdate {
  const empty: ParsedLimitUpdate = {
    tier: null,
    qualityRating: null,
    phoneNumberId: null,
  };
  if (!value || typeof value !== 'object') return empty;

  let tier: string | null = null;

  // Preferred: an explicit tier string.
  if (typeof value.current_limit === 'string' && value.current_limit.trim()) {
    tier = value.current_limit.trim().toUpperCase();
  }

  // Fallback: a numeric cap we can map back onto a known tier. An
  // unmappable number is dropped rather than guessed at — a wrong tier
  // is worse than no tier, since it drives the pre-flight warning.
  if (!tier && value.max_daily_conversation_per_phone !== undefined) {
    const n = Number(value.max_daily_conversation_per_phone);
    if (Number.isFinite(n)) {
      tier = TIER_FROM_LIMIT[n] ?? null;
    }
  }

  const rawQuality =
    value.current_quality_rating ?? value.quality_rating ?? value.event ?? null;
  const upperQuality = rawQuality
    ? String(rawQuality).trim().toUpperCase()
    : null;
  // `event` also carries FLAGGED / UNFLAGGED, which are not ratings.
  const qualityRating =
    upperQuality && QUALITY_RATINGS.has(upperQuality) ? upperQuality : null;

  return {
    tier,
    qualityRating,
    phoneNumberId: value.metadata?.phone_number_id ?? null,
  };
}
