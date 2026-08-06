import { BullModule } from '@nestjs/bullmq';
import { Module, type OnModuleInit } from '@nestjs/common';

import { QueueModule } from '../queue/queue.module';
import {
  AdsConnectController,
  AdsOAuthController,
} from './controllers/ads-connect.controller';
import { AdsInsightsController } from './controllers/ads-insights.controller';
import { AdsPublishController } from './controllers/ads-publish.controller';
import { AdsAssetsController } from './controllers/ads-assets.controller';
import { AdsPrivacyController } from './controllers/ads-privacy.controller';
import { ADS_SYNC_QUEUE, AdsSyncProcessor } from './ads-sync.processor';
import { AdsConfigService } from './services/ads-config.service';
import { AdsConnectService } from './services/ads-connect.service';
import { AdsControlService } from './services/ads-control.service';
import { AdsInsightsService } from './services/ads-insights.service';
import { AdsSyncService } from './services/ads-sync.service';
import { AdPublishService } from './services/ad-publish.service';
import { AdsTargetingService } from './services/ads-targeting.service';
import { AdsAssetsService } from './services/ads-assets.service';

/**
 * Meta Ads Manager — the Marketing API surface.
 *
 * Plan: docs/meta-ads-manager.md
 * Open items / setup: docs/meta-ads-manager-requirements.md
 *
 * Structured to mirror WebModule and InstagramModule so the modules stay
 * diffable. Two differences worth knowing about:
 *
 *   * No webhook controller. Ads have no inbound events of their own —
 *     lead-form submissions arrive on the EXISTING
 *     `/webhooks/facebook-leads` endpoint in IntegrationsModule, and
 *     Click-to-WhatsApp conversations arrive as ordinary WhatsApp
 *     messages. Adding a second lead webhook here would mean two paths
 *     creating contacts from the same Meta event.
 *
 *   * Every controller sits behind `AdsEnabledGuard` as well as its auth
 *     guard. This module is unreleased and gated on Meta App Review for
 *     `ads_management`; the flag is the release mechanism, not a
 *     convenience.
 *
 * WHY THERE ARE NO PAYMENT PROVIDERS HERE
 *   Ads run on the customer's own ad account and Meta bills them
 *   directly. There is deliberately no wallet, no ad-credit ledger and
 *   no Stripe/Razorpay involvement — see the header of migration 068.
 *
 * THE SYNC QUEUE IS REGISTERED UNCONDITIONALLY
 *   The processor itself checks `adsEnabled()` in `onModuleInit` and
 *   removes its schedule when the flag is off, which is the honest place
 *   for that decision: registering the queue conditionally would leave a
 *   previously-created repeatable job in Redis firing into a module that
 *   no longer has a worker for it.
 */
@Module({
  imports: [QueueModule, BullModule.registerQueue({ name: ADS_SYNC_QUEUE })],
  controllers: [
    AdsConnectController,
    AdsOAuthController,
    AdsInsightsController,
    AdsPublishController,
    AdsAssetsController,
    // Meta's data-deletion / deauthorize callbacks. Deliberately NOT behind
    // AdsEnabledGuard — see the controller docblock: a deletion request must
    // still be honoured after the feature is switched off.
    AdsPrivacyController,
  ],
  providers: [
    AdsConfigService,
    AdsConnectService,
    AdsSyncService,
    AdsInsightsService,
    AdsControlService,
    AdPublishService,
    AdsTargetingService,
    AdsAssetsService,
    AdsSyncProcessor,
  ],
  exports: [AdsConfigService],
})
export class AdsModule implements OnModuleInit {
  constructor(
    private readonly connect: AdsConnectService,
    private readonly sync: AdsSyncProcessor,
  ) {}

  /**
   * Wire the connect flow to the backfill queue.
   *
   * Done here rather than by injecting the processor into
   * `AdsConnectService`, which would create a dependency cycle: the
   * processor already depends on AdsSyncService → AdsConfigService. One
   * assignment at boot is cheaper than a forwardRef.
   */
  onModuleInit(): void {
    this.connect.onAdAccountSelected = (accountId) =>
      this.sync.enqueueBackfill(accountId);
  }
}
