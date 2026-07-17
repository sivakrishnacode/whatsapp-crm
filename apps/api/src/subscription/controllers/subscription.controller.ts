import { Controller, Get, HttpStatus, HttpException, UseGuards } from '@nestjs/common';
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
      const subscription = await this.subscriptionService.getUserSubscription(account.userId);
      return { subscription };
    } catch (error) {
      throw new HttpException(
        'Failed to fetch subscription',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
