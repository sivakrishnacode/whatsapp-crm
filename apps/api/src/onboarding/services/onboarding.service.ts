import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { subscription_status_enum } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ENTERPRISE_PLAN,
  RETIRED_PLAN,
  SubscriptionService,
  type PlanView,
} from '../../subscription/services/subscription.service';
import type { PlanEnquiryDto, SaveWorkspaceDto } from '../dto/onboarding.dto';
import {
  InvalidWorkspaceLogoError,
  normalizeWorkspaceLogoUrl,
} from '../../common/storage/workspace-logo.util';

/** Fallback billing period when a plan carries no trial. */
const DEFAULT_PERIOD_DAYS = 30;

/** Statuses that count as "this account has paid its way in". */
const ENTITLED_STATUSES = ['active', 'trial'] as const;

export type OnboardingStep = 'workspace' | 'plan' | 'done';

export interface OnboardingState {
  step: OnboardingStep;
  workspace: {
    name: string;
    /** Public URL in the `workspace-logos` bucket, or null for none. */
    logoUrl: string | null;
    goals: string[];
    teamSize: string | null;
    referralSource: string | null;
    referralOther: string | null;
  };
  subscription: {
    planName: string;
    planDisplayName: string;
    status: string;
    trialEndsAt: string | null;
  } | null;
  plans: PlanView[];
}

/**
 * The guided-signup wizard behind `/welcome`.
 *
 * ACCOUNT-SCOPED, DESPITE user_subscriptions BEING USER-SCOPED.
 *   `user_subscriptions.user_id` is unique per *user*, but a plan is a
 *   property of the workspace: an invited teammate must not be asked to
 *   buy their own. So the subscription this service writes always
 *   belongs to `accounts.owner_user_id`, and completion is recorded once
 *   per account in `account_onboarding`. Members of an onboarded account
 *   are never gated.
 *
 *   Making user_subscriptions genuinely account-scoped would touch the
 *   admin panel, both payment gateways and every webhook — a separate
 *   piece of work. This keeps the one-plan-per-workspace behaviour
 *   correct in the meantime.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  /** Everything `/welcome` needs to render, in one round trip. */
  async getState(accountId: string): Promise<OnboardingState> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        name: true,
        logoUrl: true,
        ownerUserId: true,
        account_onboarding: true,
      },
    });

    if (!account) {
      throw new BadRequestException('Account not found');
    }

    const [subscription, plans] = await Promise.all([
      this.findOwnerSubscription(account.ownerUserId),
      this.subscriptions.listSelectablePlans(),
    ]);

    const onboarding = account.account_onboarding;
    const isEntitled =
      subscription !== null &&
      (ENTITLED_STATUSES as readonly string[]).includes(subscription.status);

    return {
      step: this.resolveStep({
        hasWorkspace: onboarding !== null,
        isCompleted: onboarding?.completed_at != null,
        isEntitled,
      }),
      workspace: {
        name: account.name,
        logoUrl: account.logoUrl,
        goals: onboarding?.goals ?? [],
        teamSize: onboarding?.team_size ?? null,
        referralSource: onboarding?.referral_source ?? null,
        referralOther: onboarding?.referral_other ?? null,
      },
      subscription,
      plans,
    };
  }

  /**
   * Step 1. Renames the workspace and records the answers.
   *
   * Deliberately does NOT set completed_at — an abandoned wizard must
   * resume at the plan step, not walk straight into the dashboard.
   */
  async saveWorkspace(
    accountId: string,
    dto: SaveWorkspaceDto,
  ): Promise<OnboardingState> {
    const name = dto.workspaceName.trim();
    if (name.length === 0) {
      throw new BadRequestException('Workspace name cannot be empty');
    }

    // 'other' is the only source with a free-text tail; drop stale text
    // if the user picked 'other', typed something, then changed their
    // mind, so the funnel report never shows an orphaned explanation.
    const referralOther =
      dto.referralSource === 'other' ? dto.referralOther?.trim() || null : null;

    // Absent key = "don't touch the logo", so re-submitting the step from
    // a client that never sends the field cannot silently erase one.
    const accountPatch: { name: string; logoUrl?: string | null } = { name };
    if (dto.logoUrl !== undefined) {
      try {
        accountPatch.logoUrl = normalizeWorkspaceLogoUrl(
          dto.logoUrl,
          accountId,
          process.env.SUPABASE_URL,
        );
      } catch (error) {
        if (error instanceof InvalidWorkspaceLogoError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
    }

    await this.prisma.$transaction([
      this.prisma.account.update({
        where: { id: accountId },
        data: accountPatch,
      }),
      this.prisma.account_onboarding.upsert({
        where: { account_id: accountId },
        create: {
          account_id: accountId,
          goals: dto.goals,
          team_size: dto.teamSize,
          referral_source: dto.referralSource,
          referral_other: referralOther,
        },
        update: {
          goals: dto.goals,
          team_size: dto.teamSize,
          referral_source: dto.referralSource,
          referral_other: referralOther,
        },
      }),
    ]);

    return this.getState(accountId);
  }

  /**
   * Step 2. Starts the plan's trial for the account owner and closes
   * out onboarding.
   *
   * No payment is taken here: Starter and Growth both carry a 15-day
   * trial, and checkout happens from /pricing before it lapses.
   */
  async selectPlan(
    accountId: string,
    planName: string,
  ): Promise<OnboardingState> {
    const plan = await this.findSelectablePlan(planName);
    const ownerUserId = await this.getOwnerUserId(accountId);

    await this.startSubscription({
      ownerUserId,
      planId: plan.id,
      trialDays: plan.trial_days,
    });
    await this.markCompleted(accountId);

    this.logger.log(
      `Account ${accountId} onboarded onto ${plan.name} (owner ${ownerUserId})`,
    );

    return this.getState(accountId);
  }

  /**
   * Step 2, Enterprise. Records the enquiry and provisions the same
   * trial as any other tier.
   *
   * The trial matters: onboarding is a hard gate, so without it the
   * account would sit locked out of the product until a salesperson
   * replied. The negotiated price lands in `plan_enquiries` because
   * there is nowhere on user_subscriptions to put an amount.
   */
  async submitEnquiry(
    accountId: string,
    userId: string,
    dto: PlanEnquiryDto,
  ): Promise<OnboardingState> {
    const plan = await this.findSelectablePlan(ENTERPRISE_PLAN);
    const ownerUserId = await this.getOwnerUserId(accountId);

    await this.prisma.plan_enquiries.create({
      data: {
        account_id: accountId,
        user_id: userId,
        full_name: dto.fullName.trim(),
        work_email: dto.workEmail.trim(),
        phone: dto.phone?.trim() || null,
        company_size: dto.companySize ?? null,
        message: dto.message?.trim() || null,
      },
    });

    await this.startSubscription({
      ownerUserId,
      planId: plan.id,
      trialDays: plan.trial_days,
    });
    await this.markCompleted(accountId);

    this.logger.log(`Enterprise enquiry recorded for account ${accountId}`);

    return this.getState(accountId);
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private resolveStep({
    hasWorkspace,
    isCompleted,
    isEntitled,
  }: {
    hasWorkspace: boolean;
    isCompleted: boolean;
    isEntitled: boolean;
  }): OnboardingStep {
    if (!hasWorkspace) return 'workspace';
    // completed_at alone is not enough: an admin can cancel or expire a
    // subscription afterwards, and that account has to come back here
    // and choose again rather than keep the keys.
    if (!isCompleted || !isEntitled) return 'plan';
    return 'done';
  }

  private async getOwnerUserId(accountId: string): Promise<string> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { ownerUserId: true },
    });

    if (!account) {
      throw new BadRequestException('Account not found');
    }

    return account.ownerUserId;
  }

  private async findSelectablePlan(planName: string) {
    const normalized = planName.trim().toUpperCase();

    if (normalized === RETIRED_PLAN) {
      throw new BadRequestException('The free plan is no longer available');
    }

    const plan = await this.prisma.subscription_plans.findUnique({
      where: { name: normalized },
      select: { id: true, name: true, trial_days: true, is_active: true },
    });

    // is_active is checked here rather than in the query so a retired
    // plan reports as retired instead of as a typo.
    if (!plan || plan.is_active !== true) {
      throw new BadRequestException(`Unknown or inactive plan: ${normalized}`);
    }

    return plan;
  }

  private async findOwnerSubscription(ownerUserId: string) {
    const subscription = await this.prisma.user_subscriptions.findUnique({
      where: { user_id: ownerUserId },
      select: {
        status: true,
        trial_end_at: true,
        subscription_plans: { select: { name: true, display_name: true } },
      },
    });

    if (!subscription) return null;

    return {
      planName: subscription.subscription_plans.name,
      planDisplayName: subscription.subscription_plans.display_name,
      status: subscription.status,
      trialEndsAt: subscription.trial_end_at?.toISOString() ?? null,
    };
  }

  /**
   * Period maths mirrors subscription-admin.controller's assign-plan so
   * a manually-assigned plan and a self-selected one produce identical
   * rows: during a trial the billing period starts when the trial ends.
   */
  private async startSubscription({
    ownerUserId,
    planId,
    trialDays,
  }: {
    ownerUserId: string;
    planId: string;
    trialDays: number | null;
  }): Promise<void> {
    const now = new Date();
    const trialStart = trialDays ? now : null;
    const trialEnd = trialDays
      ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000)
      : null;

    const periodStart = trialEnd ?? now;
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + DEFAULT_PERIOD_DAYS);

    // Annotated rather than inferred: without the enum type, `status`
    // widens to `string` and Prisma rejects the write. `tsc --noEmit`
    // happens to accept it, so only `nest build` catches the drift.
    const status: subscription_status_enum = trialEnd ? 'trial' : 'active';

    const fields = {
      plan_id: planId,
      status,
      billing_cycle: 'monthly' as const,
      trial_start_at: trialStart,
      trial_end_at: trialEnd,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      cancel_at_period_end: false,
      payment_method: 'manual' as const,
    };

    await this.prisma.user_subscriptions.upsert({
      where: { user_id: ownerUserId },
      create: { user_id: ownerUserId, ...fields },
      // Gateway ids are left untouched: an account re-running the wizard
      // after a cancellation must not lose the link to a Razorpay or
      // Stripe subscription the webhooks still reference.
      update: fields,
    });
  }

  private async markCompleted(accountId: string): Promise<void> {
    await this.prisma.account_onboarding.upsert({
      where: { account_id: accountId },
      create: { account_id: accountId, completed_at: new Date() },
      update: { completed_at: new Date() },
    });
  }
}
