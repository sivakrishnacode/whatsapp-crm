import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ============================================================
 * Entitlement — "what may this workspace do right now?"
 *
 * One resolver, asked by one guard, so the answer cannot differ between
 * call sites. Everything here is ACCOUNT-scoped: a plan belongs to the
 * workspace and the subscription row is written for
 * `accounts.owner_user_id`, so the pre-existing per-user
 * `SubscriptionService.checkSubscriptionLimit` would have blocked every
 * invited teammate (no subscription row of their own) while letting the
 * owner through. That method and `usage_tracking` are superseded by this
 * one; nothing calls them.
 *
 * ⚠️ FAIL OPEN ON FAILURE, NOT ON LAPSE.
 *
 * If the entitlement query itself errors — a dropped connection, a
 * migration mid-flight — every check returns "allowed". That is the same
 * choice `AuthGate` makes in the web app for the onboarding gate, and for
 * the same reason: a broken lookup must never become an outage for
 * paying customers. A *successful* lookup that says the subscription has
 * lapsed is honoured; the fail-open path is only for not knowing.
 * ============================================================
 */

/** The three standings `get_account_entitlement` can return. */
export type Standing = 'good' | 'grace' | 'lapsed';

export type LimitType =
  'messages' | 'broadcasts' | 'contacts' | 'flows' | 'team_members' | 'storage';

/** Metrics that are counted as they happen (the rest are counted live). */
export type UsageMetric = 'messages' | 'broadcasts';

export interface Entitlement {
  planName: string | null;
  planDisplayName: string | null;
  status: string | null;
  standing: Standing;
  writesAllowed: boolean;
  trialEndAt: Date | null;
  currentPeriodEnd: Date | null;
  maxContacts: number | null;
  maxMessagesMonthly: number | null;
  maxBroadcastsMonthly: number | null;
  maxFlows: number | null;
  maxTeamMembers: number | null;
}

export interface LimitCheck {
  allowed: boolean;
  currentUsage: number;
  /** Null means unlimited — that is how `max_flows` encodes it. */
  limitValue: number | null;
  standing: Standing;
  reason:
    | 'ok'
    | 'unlimited'
    | 'limit_reached'
    | 'subscription_lapsed'
    | 'unknown_account'
    | 'not_metered'
    | 'check_failed';
}

interface EntitlementRow {
  plan_name: string | null;
  plan_display_name: string | null;
  status: string | null;
  standing: Standing;
  writes_allowed: boolean;
  trial_end_at: Date | null;
  current_period_end: Date | null;
  max_contacts: number | null;
  max_messages_monthly: number | null;
  max_broadcasts_monthly: number | null;
  max_flows: number | null;
  max_team_members: number | null;
}

interface LimitRow {
  allowed: boolean;
  current_usage: number;
  limit_value: number | null;
  standing: Standing;
  reason: LimitCheck['reason'];
}

/** The answer every failure path gives: yes, and say why in the log. */
const FAIL_OPEN: LimitCheck = {
  allowed: true,
  currentUsage: 0,
  limitValue: null,
  standing: 'good',
  reason: 'check_failed',
};

/** Human sentences for the two refusals a customer can actually act on. */
const LIMIT_LABELS: Record<LimitType, string> = {
  messages: 'messages this month',
  broadcasts: 'broadcasts this month',
  contacts: 'contacts',
  flows: 'active flows',
  team_members: 'team members',
  storage: 'storage',
};

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getEntitlement(accountId: string): Promise<Entitlement | null> {
    try {
      const rows = await this.prisma.$queryRaw<EntitlementRow[]>`
        SELECT plan_name, plan_display_name, status::text AS status, standing,
               writes_allowed, trial_end_at, current_period_end,
               max_contacts, max_messages_monthly, max_broadcasts_monthly,
               max_flows, max_team_members
          FROM get_account_entitlement(${accountId}::uuid)
      `;
      const row = rows[0];
      if (!row) return null;

      return {
        planName: row.plan_name,
        planDisplayName: row.plan_display_name,
        status: row.status,
        standing: row.standing,
        writesAllowed: row.writes_allowed,
        trialEndAt: row.trial_end_at,
        currentPeriodEnd: row.current_period_end,
        maxContacts: row.max_contacts,
        maxMessagesMonthly: row.max_messages_monthly,
        maxBroadcastsMonthly: row.max_broadcasts_monthly,
        maxFlows: row.max_flows,
        maxTeamMembers: row.max_team_members,
      };
    } catch (err) {
      this.logger.error(
        `[entitlement] lookup failed for account ${accountId}: ${errorText(err)}`,
      );
      return null;
    }
  }

  /**
   * Check one metric before it is spent.
   *
   * `increment` matters: a broadcast to 4,000 recipients has to be
   * refused before the fan-out enqueues 4,000 jobs, not on recipient 101.
   */
  async checkLimit(
    accountId: string,
    limitType: LimitType,
    increment = 1,
  ): Promise<LimitCheck> {
    try {
      const rows = await this.prisma.$queryRaw<LimitRow[]>`
        SELECT allowed, current_usage, limit_value, standing, reason
          FROM check_account_limit(
            ${accountId}::uuid, ${limitType}::text, ${increment}::integer
          )
      `;
      const row = rows[0];
      if (!row) return FAIL_OPEN;

      return {
        allowed: row.allowed,
        currentUsage: row.current_usage,
        limitValue: row.limit_value,
        standing: row.standing,
        reason: row.reason,
      };
    } catch (err) {
      this.logger.error(
        `[entitlement] ${limitType} check failed for account ${accountId}: ${errorText(err)}`,
      );
      return FAIL_OPEN;
    }
  }

  /**
   * Count something that has just been sent. Never throws: the message is
   * already gone, and turning a delivered message into an error because
   * its counter did not move would be the wrong trade. Same contract as
   * `AiCreditsService.chargeGeneration`.
   */
  async recordUsage(
    accountId: string,
    metric: UsageMetric,
    delta = 1,
  ): Promise<void> {
    if (delta === 0) return;

    try {
      await this.prisma
        .$executeRaw`SELECT increment_account_usage(${accountId}::uuid, ${metric}::text, ${delta}::integer)`;
    } catch (err) {
      this.logger.error(
        `[entitlement] could not record ${delta} ${metric} for account ${accountId}: ${errorText(err)}`,
      );
    }
  }

  /**
   * The sentence a customer sees. Written here rather than in the guard so
   * every surface — dashboard, public API, queue processor — refuses in
   * the same words.
   */
  refusalMessage(limitType: LimitType, check: LimitCheck): string {
    if (check.reason === 'subscription_lapsed') {
      return (
        'Your subscription has ended, so sending and creating are paused. ' +
        'Your data is still here — choose a plan to pick up where you left off.'
      );
    }

    const label = LIMIT_LABELS[limitType];
    const cap = check.limitValue ?? 0;

    return (
      `You have used ${check.currentUsage} of ${cap} ${label} on your plan. ` +
      'Upgrade to carry on, or wait for the next billing period.'
    );
  }
}

/** A thrown value is not necessarily an Error; log it without pretending. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
