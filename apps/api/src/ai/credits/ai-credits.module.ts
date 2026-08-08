import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiCreditsService } from './ai-credits.service';
import { AiCreditsController } from './ai-credits.controller';

/**
 * The credit wallet, split out of `AiModule` on purpose.
 *
 * `SubscriptionModule` needs `AiCreditsService` too — Razorpay's webhook
 * carries plan payments and credit top-ups on the same endpoint, and a
 * customer who closes the tab after paying gets their credits only
 * because that webhook can grant them. Importing the whole `AiModule`
 * there would drag in the auto-reply bot, the queue and (through
 * `WhatsappModule`) most of the app, for one method.
 *
 * This module owns no AI machinery of its own — nothing here calls a
 * provider. It counts, it charges, and it sells.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AiCreditsController],
  providers: [AiCreditsService],
  exports: [AiCreditsService],
})
export class AiCreditsModule {}
