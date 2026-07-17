import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscriptionService } from './services/subscription.service';
import { SubscriptionController } from './controllers/subscription.controller';
import { SubscriptionAdminController } from './controllers/subscription-admin.controller';
import { RazorpayController } from './controllers/razorpay.controller';
import { StripeController } from './controllers/stripe.controller';
import { SubscriptionWebhooksController } from './controllers/subscription-webhooks.controller';

@Module({
  imports: [PrismaModule],
  controllers: [
    SubscriptionController,
    SubscriptionAdminController,
    RazorpayController,
    StripeController,
    SubscriptionWebhooksController,
  ],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
