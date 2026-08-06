import {
  Controller,
  Get,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { SubscriptionService } from '../services/subscription.service';

@Controller('subscription')
@UseGuards(SupabaseAuthGuard)
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  /**
   * GET /api/subscription
   * Returns current user's subscription details + plan limits.
   */
  @Get()
  async getSubscription(@CurrentAccount() account: SupabaseAccountContext) {
    try {
      const subscription = await this.subscriptionService.getUserSubscription(
        account.userId,
      );
      return { subscription };
    } catch (error) {
      throw new HttpException(
        'Failed to fetch subscription',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/subscription/plans
   * Every selectable plan, cheapest first, straight from the table.
   *
   * The pricing page and the signup wizard both render from this rather
   * than from a hardcoded table in the web app, so a price edited in the
   * admin panel is live immediately instead of at the next deploy.
   */
  @Get('plans')
  async getPlans() {
    try {
      const plans = await this.subscriptionService.listSelectablePlans();
      return { plans };
    } catch (error) {
      throw new HttpException(
        'Failed to fetch plans',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
