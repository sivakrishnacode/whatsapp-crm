/**
 * Account health — the rules.
 *
 * Pure functions over stored evidence (lib/health/evidence.ts reads it). No
 * database, no `server-only`, no clock of its own: `now` is passed in, so the
 * rules are unit-tested (rules.test.ts) and the same evidence always grades
 * the same way.
 *
 * ## The contract (C2.0 handoff, C360-009/010/031)
 *
 * - Every check reports a state, the timestamp of the evidence it judged
 *   (`checkedAt`), the evidence itself in a sentence, and a next action.
 * - **Unknown is not Healthy.** Evidence that is missing or older than the
 *   staleness window grades `unknown`. A check that cannot see failures says
 *   so rather than reporting success by default.
 * - **Completion is not health.** `computeCompletion` is a separate function
 *   over separate questions; a fully set-up workspace can be critical.
 *
 * ## What "checking" means here
 *
 * The Control Center never calls Meta itself — it holds no customer token and
 * must not (no plaintext secrets for staff). Live probes happen in apps/api's
 * own jobs (the messaging-limits sync every 6h, the webhook pipeline). These
 * rules judge what those jobs last wrote, and staleness is how a dead job
 * shows up.
 */

export type HealthState =
  'healthy' | 'attention' | 'critical' | 'unknown' | 'not_configured';

export type HealthCategory =
  | 'meta'
  | 'messaging'
  | 'templates'
  | 'channels'
  | 'integrations'
  | 'ai'
  | 'billing';

export type HealthKey =
  | 'wa_connection'
  | 'wa_token'
  | 'wa_quality'
  | 'delivery'
  | 'templates'
  | 'instagram'
  | 'web_widget'
  | 'webhooks'
  | 'google_bridge'
  | 'ecommerce'
  | 'api_keys'
  | 'ai_credits'
  | 'billing';

export type HealthCheck = {
  key: HealthKey;
  label: string;
  category: HealthCategory;
  state: HealthState;
  /** When the evidence judged was recorded. Null when there is none. */
  checkedAt: Date | null;
  /** What was seen, in one sentence. Never contains a secret. */
  evidence: string;
  /** What an operator (or the customer) should do next. */
  action: string | null;
};

export type HealthEvidence = {
  accountId: string;
  wa: {
    status: string;
    phoneNumberId: string;
    wabaId: string | null;
    connectionMethod: string;
    coexistence: boolean;
    connectedAt: Date | null;
    registeredAt: Date | null;
    subscribedAppsAt: Date | null;
    lastRegistrationError: string | null;
    tokenExpiresAt: Date | null;
    limitsSyncedAt: Date | null;
    tier: string | null;
    quality: string | null;
    updatedAt: Date | null;
  } | null;
  /** Outbound (agent + bot) messages created in the last 7 days. */
  out7d: number;
  /** Of those, status = failed. */
  failed7d: number;
  topErrorCode: number | null;
  topErrorTitle: string | null;
  topErrorCount: number;
  /** Latest outbound message Meta confirmed delivered or read. */
  lastDeliveredAt: Date | null;
  everDelivered: boolean;
  templates: {
    total: number;
    approved: number;
    rejected: number;
    paused: number;
    pending: number;
    redQuality: number;
    updatedAt: Date | null;
  };
  ig: {
    status: string;
    username: string | null;
    lastError: string | null;
    tokenExpiresAt: Date | null;
    updatedAt: Date | null;
  } | null;
  web: {
    status: string;
    lastSeenAt: Date | null;
    lastError: string | null;
    updatedAt: Date | null;
  } | null;
  webhooks: { active: number; lastDeliveryAt: Date | null };
  google: {
    lastOkAt: Date | null;
    lastErrorAt: Date | null;
    lastError: string | null;
    scriptVersion: number | null;
  } | null;
  ecommerce: {
    total: number;
    errored: number;
    disconnected: number;
    lastSyncAt: Date | null;
  };
  apiKeys: { active: number; expiringSoon: number; lastUsedAt: Date | null };
  ai: {
    creditMode: 'platform' | 'byok' | null;
    balance: number | null;
    walletUpdatedAt: Date | null;
    activeAgents: number;
    autoReplyAgents: number;
  };
  billing: {
    status: 'active' | 'trial' | 'past_due' | 'cancelled' | 'expired' | null;
    trialEndAt: Date | null;
    periodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    updatedAt: Date | null;
  };
  setup: {
    onboardingCompletedAt: Date | null;
    members: number;
    pendingInvites: number;
  };
};

export type HealthThresholds = {
  staleHours: number;
  lowCreditThreshold: number;
  deliveryAttentionPct: number;
  deliveryCriticalPct: number;
};

/** Fewer outbound messages than this in 7 days is too few to grade. */
export const MIN_DELIVERY_SAMPLE = 20;

const DAY = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY);
}

function ago(at: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function shortDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Meta's error codes worth naming to an operator. Not exhaustive — an
 * unknown code falls back to a generic action rather than a wrong one.
 */
const META_ERROR_ACTIONS: Record<number, string> = {
  131049:
    'Meta is holding back marketing messages to these recipients to protect engagement. Reduce marketing frequency and target engaged contacts.',
  131026:
    'Recipients cannot receive these messages (not on WhatsApp, outdated app, or terms not accepted). Clean the contact list.',
  131047:
    'More than 24 hours since the customer last wrote — only an approved template can be sent. Switch the step to a template.',
  131056:
    'Too many messages to the same recipient in a short time. Space out sends to each contact.',
  131048:
    'Spam rate limit reached — the number is sending too much that recipients block or report. Pause marketing and review content.',
  132001: 'The template does not exist or is not approved in this language.',
  132000: 'Template parameter count does not match the approved template.',
  131042:
    'A payment issue on the Meta business account. The owner must fix billing in Meta Business Manager.',
  131031: 'The WhatsApp Business Account is locked or restricted by Meta.',
  190: 'The access token is invalid or expired. The customer must reconnect WhatsApp.',
};

export function evaluateHealth(
  e: HealthEvidence,
  now: Date,
  t: HealthThresholds
): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const staleMs = t.staleHours * 3_600_000;

  /* ---------- WhatsApp connection ---------- */
  if (!e.wa) {
    checks.push({
      key: 'wa_connection',
      label: 'WhatsApp connection',
      category: 'meta',
      state: 'not_configured',
      checkedAt: null,
      evidence: 'No WhatsApp number is connected.',
      action:
        'Guide the customer through Embedded Signup in Channels → WhatsApp.',
    });
  } else if (e.wa.status !== 'connected') {
    checks.push({
      key: 'wa_connection',
      label: 'WhatsApp connection',
      category: 'meta',
      state: 'critical',
      checkedAt: e.wa.updatedAt,
      evidence: `Connection status is “${e.wa.status}”.${
        e.wa.lastRegistrationError
          ? ` Last registration error: ${e.wa.lastRegistrationError}`
          : ''
      }`,
      action:
        'The customer must reconnect WhatsApp from Channels → WhatsApp (Meta owner action).',
    });
  } else if (!e.wa.registeredAt && !e.wa.coexistence) {
    checks.push({
      key: 'wa_connection',
      label: 'WhatsApp connection',
      category: 'meta',
      state: 'attention',
      checkedAt: e.wa.updatedAt,
      evidence: `Connected, but the number was never registered with the Cloud API.${
        e.wa.lastRegistrationError
          ? ` Last attempt: ${e.wa.lastRegistrationError}`
          : ''
      }`,
      action:
        'Retry registration from the customer’s WhatsApp settings; check the two-step PIN with the owner.',
    });
  } else if (!e.wa.subscribedAppsAt) {
    checks.push({
      key: 'wa_connection',
      label: 'WhatsApp connection',
      category: 'meta',
      state: 'attention',
      checkedAt: e.wa.updatedAt,
      evidence:
        'The WABA is not subscribed to our app, so inbound messages and delivery receipts may not arrive.',
      action: 'Re-run the connection so the WABA subscribes to the app.',
    });
  } else {
    checks.push({
      key: 'wa_connection',
      label: 'WhatsApp connection',
      category: 'meta',
      state: 'healthy',
      checkedAt: e.wa.updatedAt,
      evidence: `Connected${e.wa.connectedAt ? ` since ${shortDate(e.wa.connectedAt)}` : ''}${
        e.wa.coexistence
          ? ' (coexistence with the Business app)'
          : ', registered'
      }, WABA subscribed.`,
      action: null,
    });
  }

  /* ---------- WhatsApp token ---------- */
  if (!e.wa) {
    checks.push({
      key: 'wa_token',
      label: 'Meta authorization',
      category: 'meta',
      state: 'not_configured',
      checkedAt: null,
      evidence: 'No WhatsApp authorization to check.',
      action: null,
    });
  } else if (e.wa.tokenExpiresAt) {
    const days = daysBetween(now, e.wa.tokenExpiresAt);
    checks.push({
      key: 'wa_token',
      label: 'Meta authorization',
      category: 'meta',
      state:
        days < 0
          ? 'critical'
          : days <= 7
            ? 'critical'
            : days <= 14
              ? 'attention'
              : 'healthy',
      checkedAt: e.wa.updatedAt,
      evidence:
        days < 0
          ? `The access token expired on ${shortDate(e.wa.tokenExpiresAt)}.`
          : `The access token expires on ${shortDate(e.wa.tokenExpiresAt)} (in ${days} days).`,
      action:
        days <= 14
          ? 'Ask the owner to reconnect WhatsApp before it lapses.'
          : null,
    });
  } else if (
    e.lastDeliveredAt &&
    now.getTime() - e.lastDeliveredAt.getTime() < 7 * DAY
  ) {
    checks.push({
      key: 'wa_token',
      label: 'Meta authorization',
      category: 'meta',
      state: 'healthy',
      checkedAt: e.lastDeliveredAt,
      evidence: `No expiry recorded, and Meta confirmed a delivery ${ago(e.lastDeliveredAt, now)} — the token works.`,
      action: null,
    });
  } else {
    checks.push({
      key: 'wa_token',
      label: 'Meta authorization',
      category: 'meta',
      state: 'unknown',
      checkedAt: e.wa.updatedAt,
      evidence:
        'No expiry recorded and no confirmed delivery in 7 days, so nothing proves the token still works.',
      action: 'Send a test message, or ask the customer to, and recheck.',
    });
  }

  /* ---------- Quality rating & tier ---------- */
  if (!e.wa) {
    checks.push({
      key: 'wa_quality',
      label: 'Quality rating & tier',
      category: 'meta',
      state: 'not_configured',
      checkedAt: null,
      evidence: 'No number to rate.',
      action: null,
    });
  } else if (!e.wa.limitsSyncedAt) {
    checks.push({
      key: 'wa_quality',
      label: 'Quality rating & tier',
      category: 'meta',
      state: 'unknown',
      checkedAt: null,
      evidence:
        'Quality rating and messaging tier have never been synced from Meta.',
      action:
        'Check the whatsapp-limits queue in the API; the 6-hourly sync has not reached this number.',
    });
  } else if (now.getTime() - e.wa.limitsSyncedAt.getTime() > staleMs) {
    checks.push({
      key: 'wa_quality',
      label: 'Quality rating & tier',
      category: 'meta',
      state: 'unknown',
      checkedAt: e.wa.limitsSyncedAt,
      evidence: `Last synced ${ago(e.wa.limitsSyncedAt, now)} — stale (window ${t.staleHours} h). Last seen: ${e.wa.quality ?? 'no rating'}, ${e.wa.tier ?? 'no tier'}.`,
      action:
        'The 6-hourly sync is not running for this number. Check the whatsapp-limits queue.',
    });
  } else {
    const q = (e.wa.quality ?? '').toUpperCase();
    const state: HealthState =
      q === 'GREEN' || q === 'HIGH'
        ? 'healthy'
        : q === 'YELLOW' || q === 'MEDIUM'
          ? 'attention'
          : q === 'RED' || q === 'LOW'
            ? 'critical'
            : 'unknown';
    checks.push({
      key: 'wa_quality',
      label: 'Quality rating & tier',
      category: 'meta',
      state,
      checkedAt: e.wa.limitsSyncedAt,
      evidence: `Quality ${e.wa.quality ?? 'not rated'}, tier ${e.wa.tier ?? 'unknown'}.`,
      action:
        state === 'critical'
          ? 'Quality is low: Meta may restrict the number. Pause marketing sends and review what recipients are blocking.'
          : state === 'attention'
            ? 'Quality is dropping. Review recent campaigns for blocks and reports.'
            : state === 'unknown'
              ? 'Meta returned no rating for this number.'
              : null,
    });
  }

  /* ---------- Message delivery (all channels, 7 days) ---------- */
  if (e.out7d < MIN_DELIVERY_SAMPLE) {
    checks.push({
      key: 'delivery',
      label: 'Message delivery (7 days)',
      category: 'messaging',
      state: e.wa || e.ig || e.web ? 'unknown' : 'not_configured',
      checkedAt: now,
      evidence:
        e.out7d === 0
          ? 'Nothing was sent in the last 7 days.'
          : `Only ${e.out7d} message${e.out7d === 1 ? '' : 's'} sent in 7 days${
              e.failed7d > 0 ? ` (${e.failed7d} failed)` : ''
            } — too few to judge a failure rate (minimum ${MIN_DELIVERY_SAMPLE}).`,
      action: null,
    });
  } else {
    const rate = (e.failed7d / e.out7d) * 100;
    const state: HealthState =
      rate >= t.deliveryCriticalPct
        ? 'critical'
        : rate >= t.deliveryAttentionPct
          ? 'attention'
          : 'healthy';
    const top =
      e.topErrorCode !== null && e.topErrorCount > 0
        ? ` Most common: ${e.topErrorCode}${e.topErrorTitle ? ` “${e.topErrorTitle}”` : ''} (${e.topErrorCount}).`
        : '';
    checks.push({
      key: 'delivery',
      label: 'Message delivery (7 days)',
      category: 'messaging',
      state,
      checkedAt: now,
      evidence: `${e.failed7d} of ${e.out7d} outbound messages failed (${rate.toFixed(1)}%).${top}`,
      action:
        state === 'healthy'
          ? null
          : ((e.topErrorCode !== null
              ? META_ERROR_ACTIONS[e.topErrorCode]
              : undefined) ??
            'Review the failing messages in the client’s Performance tab and the error codes Meta returned.'),
    });
  }

  /* ---------- Templates ---------- */
  {
    const tp = e.templates;
    let state: HealthState;
    let evidence: string;
    let action: string | null = null;
    if (tp.total === 0) {
      state = e.wa ? 'attention' : 'not_configured';
      evidence = 'No message templates.';
      action = e.wa
        ? 'Without an approved template nothing can be sent outside the 24-hour window. Help the customer submit one.'
        : null;
    } else if (tp.approved === 0) {
      state = 'attention';
      evidence = `${tp.total} template${tp.total === 1 ? '' : 's'}, none approved (${tp.pending} pending, ${tp.rejected} rejected).`;
      action =
        'No approved template: messages outside the 24-hour window will fail.';
    } else if (tp.redQuality > 0 || tp.paused > 0) {
      state = 'attention';
      evidence = `${tp.approved} approved; ${tp.paused} paused or disabled, ${tp.redQuality} rated RED by Meta.`;
      action =
        'Low-quality templates get paused. Review the content recipients are reacting to.';
    } else if (tp.rejected > 0) {
      state = 'attention';
      evidence = `${tp.approved} approved, ${tp.rejected} rejected.`;
      action = 'Review the rejection reasons and resubmit.';
    } else {
      state = 'healthy';
      evidence = `${tp.approved} approved${tp.pending ? `, ${tp.pending} pending review` : ''}.`;
    }
    checks.push({
      key: 'templates',
      label: 'Templates',
      category: 'templates',
      state,
      checkedAt: tp.updatedAt,
      evidence,
      action,
    });
  }

  /* ---------- Instagram ---------- */
  if (!e.ig) {
    checks.push({
      key: 'instagram',
      label: 'Instagram',
      category: 'channels',
      state: 'not_configured',
      checkedAt: null,
      evidence: 'Instagram is not connected.',
      action: null,
    });
  } else {
    const days = e.ig.tokenExpiresAt
      ? daysBetween(now, e.ig.tokenExpiresAt)
      : null;
    let state: HealthState = 'healthy';
    let evidence = `Connected${e.ig.username ? ` as @${e.ig.username}` : ''}.`;
    let action: string | null = null;
    if (e.ig.status !== 'connected') {
      state = 'critical';
      evidence = `Status is “${e.ig.status}”.${e.ig.lastError ? ` ${e.ig.lastError}` : ''}`;
      action = 'The customer must reconnect Instagram.';
    } else if (days !== null && days <= 7) {
      state = days < 0 ? 'critical' : 'attention';
      evidence = `Token ${days < 0 ? 'expired' : 'expires'} ${shortDate(e.ig.tokenExpiresAt!)} — the refresh job has not renewed it.`;
      action =
        'Check the Instagram token-refresh queue; if it keeps failing the customer must reconnect.';
    } else if (e.ig.lastError) {
      state = 'attention';
      evidence = `Connected, last error: ${e.ig.lastError}`;
      action = 'Review the error; reconnect if it persists.';
    }
    checks.push({
      key: 'instagram',
      label: 'Instagram',
      category: 'channels',
      state,
      checkedAt: e.ig.updatedAt,
      evidence,
      action,
    });
  }

  /* ---------- Web widget ---------- */
  if (!e.web || e.web.status === 'disconnected') {
    checks.push({
      key: 'web_widget',
      label: 'Web chat widget',
      category: 'channels',
      state: 'not_configured',
      checkedAt: e.web?.updatedAt ?? null,
      evidence: e.web
        ? 'Configured but never seen live on the customer’s site.'
        : 'The web widget is not set up.',
      action: null,
    });
  } else if (e.web.status === 'disabled') {
    checks.push({
      key: 'web_widget',
      label: 'Web chat widget',
      category: 'channels',
      state: 'not_configured',
      checkedAt: e.web.updatedAt,
      evidence: 'Switched off by the customer.',
      action: null,
    });
  } else {
    const seen = e.web.lastSeenAt;
    const stale = !seen || now.getTime() - seen.getTime() > 14 * DAY;
    checks.push({
      key: 'web_widget',
      label: 'Web chat widget',
      category: 'channels',
      state: e.web.lastError ? 'attention' : stale ? 'unknown' : 'healthy',
      checkedAt: seen ?? e.web.updatedAt,
      evidence: e.web.lastError
        ? `Last error: ${e.web.lastError}`
        : seen
          ? `Last loaded on the customer’s site ${ago(seen, now)}.`
          : 'Live, but never seen loading.',
      action: e.web.lastError
        ? 'Check the allowed origins in the customer’s widget settings.'
        : stale
          ? 'The widget has not loaded in 14 days — it may have been removed from the site.'
          : null,
    });
  }

  /* ---------- Outbound webhooks (the customer's CRM) ---------- */
  if (e.webhooks.active === 0) {
    checks.push({
      key: 'webhooks',
      label: 'CRM webhooks',
      category: 'integrations',
      state: 'not_configured',
      checkedAt: null,
      evidence: 'No active webhook endpoints.',
      action: null,
    });
  } else {
    const last = e.webhooks.lastDeliveryAt;
    const recent = last && now.getTime() - last.getTime() < 7 * DAY;
    checks.push({
      key: 'webhooks',
      label: 'CRM webhooks',
      category: 'integrations',
      state: recent ? 'healthy' : 'unknown',
      checkedAt: last,
      evidence: recent
        ? `${e.webhooks.active} active endpoint${e.webhooks.active === 1 ? '' : 's'}; last successful delivery ${ago(last!, now)}.`
        : `${e.webhooks.active} active endpoint${e.webhooks.active === 1 ? '' : 's'}, no successful delivery in 7 days. Failed attempts are kept only in the webhook-delivery queue, not the database, so this check cannot see them.`,
      action: recent
        ? null
        : 'Look the endpoint up in the queue dashboard (/admin/queues on the API) for recent failures.',
    });
  }

  /* ---------- Google (Apps Script bridge) ---------- */
  if (!e.google) {
    checks.push({
      key: 'google_bridge',
      label: 'Google bridge',
      category: 'integrations',
      state: 'not_configured',
      checkedAt: null,
      evidence: 'Google is not connected.',
      action: null,
    });
  } else {
    const { lastOkAt, lastErrorAt, lastError, scriptVersion } = e.google;
    const failing = lastErrorAt && (!lastOkAt || lastErrorAt > lastOkAt);
    checks.push({
      key: 'google_bridge',
      label: 'Google bridge',
      category: 'integrations',
      state: failing ? 'attention' : lastOkAt ? 'healthy' : 'unknown',
      checkedAt: failing ? lastErrorAt : lastOkAt,
      evidence: failing
        ? `The last call failed ${ago(lastErrorAt!, now)}${lastError ? `: ${lastError}` : '.'}`
        : lastOkAt
          ? `Last successful call ${ago(lastOkAt, now)}${scriptVersion ? `, script v${scriptVersion}` : ''}.`
          : 'Provisioned, but never called successfully.',
      action: failing
        ? 'The script lives in the customer’s Google account — they may need to redeploy or re-authorize it.'
        : null,
    });
  }

  /* ---------- E-commerce store sync ---------- */
  if (e.ecommerce.total === 0) {
    checks.push({
      key: 'ecommerce',
      label: 'Store sync',
      category: 'integrations',
      state: 'not_configured',
      checkedAt: null,
      evidence: 'No store connected.',
      action: null,
    });
  } else {
    const bad = e.ecommerce.errored + e.ecommerce.disconnected;
    checks.push({
      key: 'ecommerce',
      label: 'Store sync',
      category: 'integrations',
      state: bad > 0 ? 'attention' : 'healthy',
      checkedAt: e.ecommerce.lastSyncAt,
      evidence:
        bad > 0
          ? `${e.ecommerce.errored} store${e.ecommerce.errored === 1 ? '' : 's'} with a sync error, ${e.ecommerce.disconnected} disconnected.`
          : `${e.ecommerce.total} store${e.ecommerce.total === 1 ? '' : 's'} syncing${e.ecommerce.lastSyncAt ? `, last ${ago(e.ecommerce.lastSyncAt, now)}` : ''}.`,
      action:
        bad > 0
          ? 'Ask the customer to reconnect the store from Integrations.'
          : null,
    });
  }

  /* ---------- API keys ---------- */
  checks.push({
    key: 'api_keys',
    label: 'API credentials',
    category: 'integrations',
    state:
      e.apiKeys.active === 0
        ? 'not_configured'
        : e.apiKeys.expiringSoon > 0
          ? 'attention'
          : 'healthy',
    checkedAt: e.apiKeys.lastUsedAt,
    evidence:
      e.apiKeys.active === 0
        ? 'No active API keys.'
        : `${e.apiKeys.active} active key${e.apiKeys.active === 1 ? '' : 's'}${
            e.apiKeys.expiringSoon
              ? `, ${e.apiKeys.expiringSoon} expiring within 7 days`
              : ''
          }${e.apiKeys.lastUsedAt ? `; last used ${ago(e.apiKeys.lastUsedAt, now)}` : '; never used'}.`,
    action:
      e.apiKeys.expiringSoon > 0
        ? 'Tell the customer to rotate the expiring key before their integration stops.'
        : null,
  });

  /* ---------- AI credits ---------- */
  {
    const ai = e.ai;
    let state: HealthState;
    let evidence: string;
    let action: string | null = null;
    if (ai.activeAgents === 0) {
      state = 'not_configured';
      evidence = 'No AI agent is switched on.';
    } else if (ai.creditMode === 'byok') {
      state = 'healthy';
      evidence = `${ai.activeAgents} active agent${ai.activeAgents === 1 ? '' : 's'} on the customer’s own provider key — not metered.`;
    } else {
      const balance = ai.balance ?? 0;
      if (balance === 0) {
        state = ai.autoReplyAgents > 0 ? 'critical' : 'attention';
        evidence =
          ai.autoReplyAgents > 0
            ? 'Auto-reply is on but the credit wallet is empty — the bot is not answering customers.'
            : 'The credit wallet is empty; drafts and the playground will refuse.';
        action =
          'Prompt a top-up, or grant goodwill credits from AI Credits & Usage.';
      } else if (balance <= t.lowCreditThreshold) {
        state = 'attention';
        evidence = `${balance} credits left (low at ${t.lowCreditThreshold}).`;
        action = 'Suggest a top-up before the wallet runs out.';
      } else {
        state = 'healthy';
        evidence = `${balance.toLocaleString('en-IN')} platform credits, ${ai.activeAgents} active agent${ai.activeAgents === 1 ? '' : 's'}.`;
      }
    }
    checks.push({
      key: 'ai_credits',
      label: 'AI agents & credits',
      category: 'ai',
      state,
      checkedAt: ai.walletUpdatedAt,
      evidence,
      action,
    });
  }

  /* ---------- Billing standing ---------- */
  {
    const b = e.billing;
    let state: HealthState;
    let evidence: string;
    let action: string | null = null;
    switch (b.status) {
      case null:
        state = 'not_configured';
        evidence = 'No subscription — the workspace has not chosen a plan.';
        break;
      case 'active':
        if (b.cancelAtPeriodEnd) {
          state = 'attention';
          evidence = `Active, set to cancel at period end${b.periodEnd ? ` (${shortDate(b.periodEnd)})` : ''}.`;
          action = 'Renewal risk: reach out before the period ends.';
        } else {
          state = 'healthy';
          evidence = `Active${b.periodEnd ? `, renews ${shortDate(b.periodEnd)}` : ''}.`;
        }
        break;
      case 'trial': {
        const left = b.trialEndAt ? daysBetween(now, b.trialEndAt) : null;
        state = left !== null && left <= 3 ? 'attention' : 'healthy';
        evidence =
          left === null
            ? 'On trial.'
            : left < 0
              ? `Trial ended ${shortDate(b.trialEndAt!)} — awaiting the sweep.`
              : `On trial, ${left} day${left === 1 ? '' : 's'} left.`;
        action =
          state === 'attention'
            ? 'Trial ending — a good moment for a conversion call.'
            : null;
        break;
      }
      case 'past_due':
        state = 'attention';
        evidence =
          'Payment failed — in dunning. Still entitled; nothing is locked yet.';
        action =
          'Send a payment reminder; confirm the payment method with the owner.';
        break;
      case 'cancelled':
      case 'expired':
        state = 'critical';
        evidence = `Subscription ${b.status} — the workspace is locked to the billing screen.`;
        action = 'Renewal or win-back conversation; only the owner can pay.';
        break;
    }
    checks.push({
      key: 'billing',
      label: 'Billing standing',
      category: 'billing',
      state,
      checkedAt: b.updatedAt,
      evidence,
      action,
    });
  }

  return checks;
}

const RANK: Record<HealthState, number> = {
  critical: 4,
  attention: 3,
  unknown: 2,
  healthy: 1,
  not_configured: 0,
};

/**
 * The worst configured state. Unknown outranks Healthy on purpose: one check
 * we cannot see through is a reason not to call the account healthy.
 */
export function overallHealth(checks: HealthCheck[]): HealthState {
  let worst: HealthState = 'not_configured';
  for (const check of checks) {
    if (RANK[check.state] > RANK[worst]) worst = check.state;
  }
  return worst;
}

/** Checks that need someone to act — the incident list. */
export function isIncident(check: HealthCheck): boolean {
  return check.state === 'critical' || check.state === 'attention';
}

/* ============================================================
 * Setup completion — deliberately a different function over different
 * questions. Weights are the C2.0 handoff's proposal.
 * ============================================================ */

export type CompletionItem = {
  key: string;
  label: string;
  weight: number;
  /** null = we do not record this yet; excluded from the denominator. */
  done: boolean | null;
  hint: string;
};

export function computeCompletion(e: HealthEvidence): {
  percent: number;
  items: CompletionItem[];
} {
  const items: CompletionItem[] = [
    {
      key: 'business',
      label: 'Business details',
      weight: 15,
      done: e.setup.onboardingCompletedAt !== null,
      hint: 'Workspace name and qualification answers from the welcome wizard.',
    },
    {
      key: 'meta',
      label: 'Meta authorization',
      weight: 15,
      done: Boolean(e.wa?.wabaId),
      hint: 'A WhatsApp Business Account linked through Embedded Signup.',
    },
    {
      key: 'phone',
      label: 'Phone number',
      weight: 20,
      done: Boolean(
        e.wa &&
        e.wa.status === 'connected' &&
        (e.wa.registeredAt || e.wa.coexistence)
      ),
      hint: 'Connected and registered with the Cloud API (or coexistence).',
    },
    {
      key: 'profile',
      label: 'Operational profile',
      weight: 10,
      done: null,
      hint: 'Business hours and support details are not recorded in a form the Control Center can read yet, so this item is left out of the percentage.',
    },
    {
      key: 'ai',
      label: 'AI assistant',
      weight: 15,
      done: e.ai.activeAgents > 0,
      hint: 'At least one AI agent switched on.',
    },
    {
      key: 'team',
      label: 'Team',
      weight: 10,
      done: e.setup.members > 1 || e.setup.pendingInvites > 0,
      hint: 'Someone besides the owner invited or joined.',
    },
    {
      key: 'launch',
      label: 'Test & launch',
      weight: 15,
      done: e.everDelivered,
      hint: 'At least one outbound message confirmed delivered by Meta.',
    },
  ];

  const tracked = items.filter((item) => item.done !== null);
  const total = tracked.reduce((sum, item) => sum + item.weight, 0);
  const earned = tracked
    .filter((item) => item.done)
    .reduce((sum, item) => sum + item.weight, 0);

  return {
    percent: total > 0 ? Math.round((earned / total) * 100) : 0,
    items,
  };
}
