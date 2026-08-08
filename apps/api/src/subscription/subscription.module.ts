import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscriptionService } from './services/subscription.service';
import { SubscriptionController } from './controllers/subscription.controller';
import { RazorpayController } from './controllers/razorpay.controller';
import { StripeController } from './controllers/stripe.controller';
import { SubscriptionWebhooksController } from './controllers/subscription-webhooks.controller';
import { AiCreditsModule } from '../ai/credits/ai-credits.module';

/**
 * There is deliberately no `subscription/admin` controller here.
 *
 * It used to expose GET /subscription/admin/users, POST
 * /subscription/admin/assign-plan and POST /subscription/admin/cancel.
 * All three ran through Prisma — which uses the service role and so
 * bypasses RLS — with no account scoping at all: `users` listed every
 * profile in the database, and the other two acted on any `targetUserId`
 * the caller sent. Being an admin of *a* workspace was enough to read
 * every tenant's users and rewrite their subscriptions.
 *
 * Nothing consumed them (the page that existed queried Supabase
 * directly, where RLS did scope correctly), so they were removed rather
 * than patched. Cross-tenant billing administration is what
 * `apps/admin-panel` is for; that app is cross-tenant by design, which
 * is exactly why its auth is separate.
 */
@Module({
  // Razorpay's webhook carries AI credit top-ups alongside plan
  // payments, so the handler needs to be able to grant them.
  imports: [PrismaModule, AiCreditsModule],
  controllers: [
    SubscriptionController,
    RazorpayController,
    StripeController,
    SubscriptionWebhooksController,
  ],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
