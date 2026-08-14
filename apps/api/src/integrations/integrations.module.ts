import { Module } from '@nestjs/common';
import { ZapierController } from './controllers/zapier.controller';
import { V1Module } from '../v1/v1.module';

/**
 * Third-party integrations that are neither a channel nor an app
 * connection.
 *
 * WHAT LEFT, AND WHERE IT WENT
 *   Facebook Leads used to live here: a Facebook-JS-SDK connect flow, a
 *   per-Page lead-sync toggle, and the `/webhooks/facebook-leads`
 *   endpoint behind them. The integration is gone (migration 081 dropped
 *   `facebook_connections` and `facebook_pages`) but the webhook is not —
 *   the Ads Manager's lead-form ad type is now its only consumer, so
 *   controller, service and processor moved to `src/ads`, resolving their
 *   tenant through `meta_ads_config` instead.
 *
 *   OAuth app connections — Google Sheets, Gmail, Calendar, Meet — are
 *   NOT here either. They are `src/connections`, which owns token
 *   storage, refresh and the connector catalogue for every provider.
 *   See docs/app-connections.md.
 *
 * What remains is Zapier: outbound webhook endpoints registered by the
 * user, with no OAuth and no stored third-party credential.
 */
@Module({
  // V1Module for WebhookDeliverService — a Zapier connection IS a
  // `webhook_endpoints` row, so the controller shares the delivery
  // service with the public API.
  //
  // QueueModule is deliberately NOT here any more: the only thing that
  // needed it was the lead-fetch queue, which moved to AdsModule with
  // migration 081.
  imports: [V1Module],
  controllers: [ZapierController],
})
export class IntegrationsModule {}
