import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import {
  PlanEnquiryDto,
  SaveWorkspaceDto,
  SelectPlanDto,
} from '../dto/onboarding.dto';
import {
  OnboardingService,
  type OnboardingState,
} from '../services/onboarding.service';

/** Naming the workspace and buying a plan are owner/admin acts. */
function canConfigureAccount(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * `/onboarding` — the guided-signup wizard the web app serves at
 * `/welcome`. Internal dashboard surface, Supabase cookie auth.
 *
 * Reads are open to any member so the shell can decide whether to gate
 * them; writes are admin+, matching both PATCH /account and the RLS on
 * `account_onboarding`.
 */
@Controller('onboarding')
@UseGuards(SupabaseAuthGuard)
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  /** GET /api/onboarding — current step, saved answers, selectable plans. */
  @Get()
  async getState(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<OnboardingState> {
    return this.onboardingService.getState(account.accountId, account.userId);
  }

  /** PUT /api/onboarding/workspace — step 1. */
  @Put('workspace')
  async saveWorkspace(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: SaveWorkspaceDto,
  ): Promise<OnboardingState> {
    this.assertCanConfigure(account);
    return this.onboardingService.saveWorkspace(
      account.accountId,
      dto,
      account.userId,
    );
  }

  /** POST /api/onboarding/plan — step 2, starts the trial. */
  @Post('plan')
  async selectPlan(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: SelectPlanDto,
  ): Promise<OnboardingState> {
    this.assertCanConfigure(account);
    return this.onboardingService.selectPlan(
      account.accountId,
      dto.planName,
      account.userId,
    );
  }

  /** POST /api/onboarding/enquiry — step 2, Enterprise branch. */
  @Post('enquiry')
  async submitEnquiry(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: PlanEnquiryDto,
  ): Promise<OnboardingState> {
    this.assertCanConfigure(account);
    return this.onboardingService.submitEnquiry(
      account.accountId,
      account.userId,
      dto,
    );
  }

  private assertCanConfigure(account: SupabaseAccountContext): void {
    if (!canConfigureAccount(account.role)) {
      throw new ForbiddenException('Admin+ required');
    }
  }
}
