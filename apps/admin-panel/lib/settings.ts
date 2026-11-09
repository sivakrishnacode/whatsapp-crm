/**
 * Control Center settings (`admin_settings`, migration 098) — the schema.
 *
 * Pure: types, defaults and validation only. The database read is
 * `getSettings()` in lib/settings-store.ts, kept apart so tests and client
 * components can import this file without pulling in Prisma.
 *
 * Key/value rows with the defaults defined HERE, so an absent row means
 * "default" and a new setting is a code change with no migration. Every value
 * is validated on read: a hand-edited row with a nonsense number falls back to
 * the default instead of, say, setting every SLA to zero minutes and marking
 * the whole desk breached.
 */

export type Severity = 'low' | 'normal' | 'high' | 'critical';

export type SlaTarget = {
  /** Minutes from creation to the first staff response. */
  firstResponseMinutes: number;
  /** Minutes from creation to resolution. */
  resolutionMinutes: number;
};

export type ControlCenterSettings = {
  sla: Record<Severity, SlaTarget>;
  /** Default window of the renewal watchlist, in days (7, 15 or 30). */
  renewalWindowDays: 7 | 15 | 30;
  /** Channel evidence older than this reads as Unknown, never Healthy. */
  healthStaleHours: number;
  /** Platform-credit balance at or below this is "low". */
  lowCreditThreshold: number;
  /** Days in one onboarding stage before it counts as stalled. */
  stalledOnboardingDays: number;
  /** Days without a message before a live client counts as inactive. */
  inactiveClientDays: number;
  /** 7-day outbound failure rate (%) that raises Attention / Critical. */
  deliveryAttentionPct: number;
  deliveryCriticalPct: number;
};

export const DEFAULT_SETTINGS: ControlCenterSettings = {
  sla: {
    critical: { firstResponseMinutes: 30, resolutionMinutes: 4 * 60 },
    high: { firstResponseMinutes: 2 * 60, resolutionMinutes: 24 * 60 },
    normal: { firstResponseMinutes: 8 * 60, resolutionMinutes: 3 * 24 * 60 },
    low: { firstResponseMinutes: 24 * 60, resolutionMinutes: 7 * 24 * 60 },
  },
  renewalWindowDays: 15,
  // The API syncs quality and tier every 6 hours; four missed syncs in a row
  // is a broken job, not a quiet night.
  healthStaleHours: 24,
  // Mirrors LOW_BALANCE_THRESHOLD in apps/api/src/ai/credits — the point at
  // which the customer is warned. Changing it here changes what the panel
  // highlights, not what the customer is told.
  lowCreditThreshold: 50,
  stalledOnboardingDays: 3,
  inactiveClientDays: 14,
  deliveryAttentionPct: 10,
  deliveryCriticalPct: 25,
};

export const SETTING_KEYS = [
  'sla',
  'renewalWindowDays',
  'healthStaleHours',
  'lowCreditThreshold',
  'stalledOnboardingDays',
  'inactiveClientDays',
  'deliveryAttentionPct',
  'deliveryCriticalPct',
] as const satisfies readonly (keyof ControlCenterSettings)[];

export type SettingKey = (typeof SETTING_KEYS)[number];

function positiveInt(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= max
    ? value
    : fallback;
}

function parseSla(value: unknown): ControlCenterSettings['sla'] {
  const out = { ...DEFAULT_SETTINGS.sla };
  if (!value || typeof value !== 'object') return out;
  for (const severity of ['low', 'normal', 'high', 'critical'] as const) {
    const row = (value as Record<string, unknown>)[severity];
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const fallback = DEFAULT_SETTINGS.sla[severity];
    const first = positiveInt(
      r.firstResponseMinutes,
      fallback.firstResponseMinutes,
      60 * 24 * 30
    );
    const resolve = positiveInt(
      r.resolutionMinutes,
      fallback.resolutionMinutes,
      60 * 24 * 90
    );
    // A resolution target sooner than the first response is incoherent.
    out[severity] = {
      firstResponseMinutes: first,
      resolutionMinutes: Math.max(resolve, first),
    };
  }
  return out;
}

/** Pure — exported for tests and for the settings form's preview. */
export function parseSettings(
  rows: { key: string; value: unknown }[]
): ControlCenterSettings {
  const raw = new Map(rows.map((row) => [row.key, row.value]));
  const d = DEFAULT_SETTINGS;
  const windowDays = raw.get('renewalWindowDays');
  const attention = positiveInt(
    raw.get('deliveryAttentionPct'),
    d.deliveryAttentionPct,
    100
  );
  return {
    sla: parseSla(raw.get('sla')),
    renewalWindowDays:
      windowDays === 7 || windowDays === 15 || windowDays === 30
        ? windowDays
        : d.renewalWindowDays,
    healthStaleHours: positiveInt(
      raw.get('healthStaleHours'),
      d.healthStaleHours,
      24 * 30
    ),
    lowCreditThreshold: positiveInt(
      raw.get('lowCreditThreshold'),
      d.lowCreditThreshold,
      1_000_000
    ),
    stalledOnboardingDays: positiveInt(
      raw.get('stalledOnboardingDays'),
      d.stalledOnboardingDays,
      365
    ),
    inactiveClientDays: positiveInt(
      raw.get('inactiveClientDays'),
      d.inactiveClientDays,
      365
    ),
    deliveryAttentionPct: attention,
    deliveryCriticalPct: Math.max(
      positiveInt(raw.get('deliveryCriticalPct'), d.deliveryCriticalPct, 100),
      attention
    ),
  };
}
