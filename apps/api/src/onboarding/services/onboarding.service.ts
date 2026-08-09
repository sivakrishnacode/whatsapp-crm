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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The date columns for a freshly granted trial: the trial runs from now,
 * and the first billing period starts when it ends.
 */
function trialWindow(now: Date, trialDays: number) {
  const trialEnd = new Date(now.getTime() + trialDays * DAY_MS);
  const periodEnd = new Date(trialEnd);
  periodEnd.setDate(periodEnd.getDate() + DEFAULT_PERIOD_DAYS);

  return {
    trial_start_at: now,
    trial_end_at: trialEnd,
    current_period_start: trialEnd,
    current_period_end: periodEnd,
  };
}

/** The same columns for a plan with no trial: the period starts now. */
function paidWindow(now: Date) {
  const periodEnd = new Date(now);
  periodEnd.setDate(periodEnd.getDate() + DEFAULT_PERIOD_DAYS);

  return {
    trial_start_at: null,
    trial_end_at: null,
    current_period_start: now,
    current_period_end: periodEnd,
  };
}

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
  /**
   * Whether picking a plan would still start a trial. False once this
   * workspace has had its one trial (migration 074), which is what lets
   * the wizard say "your trial has ended — choose a plan and pay"
   * instead of offering a free fortnight it will not deliver.
   */
  trialAvailable: boolean;
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
      trialAvailable:
        onboarding?.trial_granted_at == null &&
        subscription?.trialEndsAt == null,
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
   * Step 2. Puts the account on a plan and closes out onboarding.
   *
   * No payment is taken here: the trial carries them, and checkout
   * happens from /pricing before it lapses.
   *
   * ⚠️ Switching plans does NOT restart the trial — see
   * `startSubscription`. A workspace gets one trial, ever.
   *
   * A subscription that is already `active` is refused: that account is
   * paying, and letting the wizard endpoint move a payer onto another
   * tier would change what they are entitled to without changing what
   * they are charged. Plan changes for a paying account belong to
   * checkout.
   */
  async selectPlan(
    accountId: string,
    planName: string,
  ): Promise<OnboardingState> {
    const plan = await this.findSelectablePlan(planName);
    const ownerUserId = await this.getOwnerUserId(accountId);
    const existing = await this.findOwnerSubscription(ownerUserId);

    if (existing?.status === 'active') {
      throw new BadRequestException(
        'This workspace already has a paid plan. Change it from Settings → ' +
          'Plan & billing.',
      );
    }

    await this.startSubscription({
      accountId,
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
   * Step 2, Enterprise. Records the enquiry, and provisions a trial ONLY
   * for an account that has no working subscription yet.
   *
   * ⚠️ AN ENQUIRY IS A SALES SIGNAL, NOT A BILLING CHANGE. This endpoint
   * is reachable from two places, and they need opposite behaviour:
   *
   *   - `/welcome`, for a brand-new account. Onboarding is a hard gate,
   *     so something has to be provisioned or the workspace sits locked
   *     out until a salesperson replies. Hence the trial.
   *   - `/pricing`, for an account that is already running. Here the
   *     original code ran the same upsert and so *overwrote a live
   *     subscription*: a paying Growth customer who asked a question
   *     about Enterprise was moved onto a free Enterprise trial, their
   *     `payment_method` rewritten to `manual` while their gateway id
   *     stayed put — the gateway kept charging a customer our own
   *     records showed as a manual trial — and their MRR silently
   *     became zero, because Enterprise is priced 0 for "quoted".
   *
   * So the trial is now conditional on the account not already being
   * entitled. The enquiry row is written either way; that is the part
   * sales actually needs. The negotiated price still lives in
   * `plan_enquiries` because `user_subscriptions` has nowhere to put an
   * amount — see the admin panel's README on giving such a customer
   * their own private plan row.
   */
  async submitEnquiry(
    accountId: string,
    userId: string,
    dto: PlanEnquiryDto,
  ): Promise<OnboardingState> {
    const ownerUserId = await this.getOwnerUserId(accountId);
    const existing = await this.findOwnerSubscription(ownerUserId);
    const alreadyEntitled =
      existing !== null &&
      (ENTITLED_STATUSES as readonly string[]).includes(existing.status);

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

    if (alreadyEntitled) {
      this.logger.log(
        `Enterprise enquiry recorded for account ${accountId}; ` +
          `left on ${existing.planName} (${existing.status})`,
      );
      return this.getState(accountId);
    }

    const plan = await this.findSelectablePlan(ENTERPRISE_PLAN);
    await this.startSubscription({
      accountId,
      ownerUserId,
      planId: plan.id,
      trialDays: plan.trial_days,
    });
    await this.markCompleted(accountId);

    this.logger.log(
      `Enterprise enquiry recorded for account ${accountId}; provisioned trial`,
    );

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
  /**
   * Put the owner's subscription on a plan.
   *
   * ⚠️ ONE TRIAL PER WORKSPACE, EVER (migration 074).
   *
   * This used to write `trial_start_at = now()` on every call, and both
   * callers are reachable repeatedly — so clicking between Starter,
   * Growth and Enterprise granted a fresh 15 days each time and the
   * product was free for as long as somebody kept changing their mind.
   *
   * `account_onboarding.trial_granted_at` is the latch. When it is set,
   * the trial columns are not written at all: the existing window is
   * carried forward, and the resulting status is whatever that window
   * says — still `trial` while it runs, `expired` once it has passed.
   * Only an operator in apps/admin-panel can grant time after that, and
   * that is deliberate: an extension is a decision someone is making,
   * recorded in `admin_audit_log`.
   *
   * The latch is checked against the subscription row as well as the
   * column, so an account that somehow carries a trial start without a
   * latch cannot claim a second one either.
   */
  private async startSubscription({
    accountId,
    ownerUserId,
    planId,
    trialDays,
  }: {
    accountId: string;
    ownerUserId: string;
    planId: string;
    trialDays: number | null;
  }): Promise<void> {
    const now = new Date();

    const [existing, onboarding] = await Promise.all([
      this.prisma.user_subscriptions.findUnique({
        where: { user_id: ownerUserId },
        select: {
          trial_start_at: true,
          trial_end_at: true,
          stripe_subscription_id: true,
          razorpay_subscription_id: true,
        },
      }),
      this.prisma.account_onboarding.findUnique({
        where: { account_id: accountId },
        select: { trial_granted_at: true },
      }),
    ]);

    const trialAlreadyUsed =
      onboarding?.trial_granted_at != null || existing?.trial_start_at != null;
    const grantTrial = trialDays !== null && trialDays > 0 && !trialAlreadyUsed;

    // Rewriting this to 'manual' while a gateway id is still present is
    // how a record comes to claim nobody is charging a customer Razorpay
    // is charging every month. The ids are deliberately left in place
    // (a cancelled subscription's webhooks still reference them), so the
    // method has to be left alone with them.
    const hasGateway = Boolean(
      existing?.stripe_subscription_id ?? existing?.razorpay_subscription_id,
    );

    // Annotated rather than inferred: without the enum type, `status`
    // widens to `string` and Prisma rejects the write. `tsc --noEmit`
    // happens to accept it, so only `nest build` catches the drift.
    const status: subscription_status_enum = grantTrial
      ? 'trial'
      : trialAlreadyUsed
        ? // The carried-forward window decides. A plan switch mid-trial
          // stays on trial; one after it has lapsed lands expired, which
          // is the honest state for "your trial is spent and you have
          // not paid" — it must not silently read as active.
          this.trialStillRunning(existing?.trial_end_at, now)
          ? 'trial'
          : 'expired'
        : // No trial on this plan at all: straight onto a paid period.
          'active';

    // The date columns are set as a group or not at all, so "switching
    // plans leaves the clock alone" is one empty object rather than four
    // conditionals that could disagree with each other.
    const window = grantTrial
      ? trialWindow(now, trialDays)
      : trialAlreadyUsed
        ? {}
        : paidWindow(now);

    const fields = {
      plan_id: planId,
      status,
      billing_cycle: 'monthly' as const,
      cancel_at_period_end: false,
      ...(hasGateway ? {} : { payment_method: 'manual' as const }),
      ...window,
    };

    await this.prisma.user_subscriptions.upsert({
      where: { user_id: ownerUserId },
      create: { user_id: ownerUserId, ...fields },
      // Gateway ids are left untouched: an account re-running the wizard
      // after a cancellation must not lose the link to a Razorpay or
      // Stripe subscription the webhooks still reference.
      update: fields,
    });

    if (grantTrial) {
      // Latched in the same operation that granted it. The upsert above
      // is the only writer of the window, so a latch without a window
      // (or the reverse) is not a state this path can produce.
      await this.prisma.account_onboarding.upsert({
        where: { account_id: accountId },
        create: { account_id: accountId, trial_granted_at: now },
        update: { trial_granted_at: now },
      });
    }
  }

  /** Is a carried-forward trial window still open? */
  private trialStillRunning(
    trialEndAt: Date | null | undefined,
    now: Date,
  ): boolean {
    return trialEndAt != null && trialEndAt.getTime() > now.getTime();
  }

  private async markCompleted(accountId: string): Promise<void> {
    await this.prisma.account_onboarding.upsert({
      where: { account_id: accountId },
      create: { account_id: accountId, completed_at: new Date() },
      update: { completed_at: new Date() },
    });
  }
}
