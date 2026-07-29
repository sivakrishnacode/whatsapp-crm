import { Module, forwardRef } from '@nestjs/common';

import { WebConfigController } from './controllers/web-config.controller';
import { WebDashboardController } from './controllers/web-dashboard.controller';
import { WebPublicController } from './controllers/web-public.controller';
import { WebStreamController } from './controllers/web-stream.controller';

import { WebConfigService } from './services/web-config.service';
import { WebSessionService } from './services/web-session.service';
import { WebSendService } from './services/web-send.service';
import { WebInboundService } from './services/web-inbound.service';
import { WebStreamService } from './services/web-stream.service';
import { WebMediaService } from './services/web-media.service';
import { WebSessionsService } from './services/web-sessions.service';

import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { V1Module } from '../v1/v1.module';
import { AutomationsModule } from '../automations/automations.module';
import { FlowsModule } from '../flows/flows.module';
import { AiModule } from '../ai/ai.module';
// Pre-chat capture, the offline form and inline form cards are all just
// forms, so the widget resolves and submits them through FormsService /
// FormSubmitService rather than growing a second form implementation.
// forwardRef because FormsModule reaches back for the web conversation
// context when a widget submission needs to reply in-thread.
import { FormsModule } from '../forms/forms.module';

/**
 * The website chat widget — the first channel whose transport we own.
 *
 * Structured to mirror InstagramModule and WhatsappModule so the three
 * channels stay diffable, with two differences that follow from owning
 * the transport rather than borrowing Meta's:
 *
 *   * No webhook controller, and no OAuth. There is no third party to
 *     receive events from or authorise against — visitors talk to us
 *     directly, so inbound arrives on our own endpoints and outbound is
 *     a database write plus a Redis publish.
 *   * A visitor-facing public surface. WhatsApp and Instagram are only
 *     ever reached by Meta's servers and our own dashboard; this channel
 *     is additionally called by anonymous browsers on third-party sites.
 *     Those routes live on their own controllers (`public/web/*`) with
 *     their own guards, so a forgotten decorator cannot silently expose
 *     an account-scoped endpoint.
 *
 * FORWARDREFS ARE LOAD-BEARING
 *   Same cycle the other two channels have: this module imports the three
 *   engines so inbound messages can drive them, and MessagingModule
 *   imports this one so `ChannelSenderService` can reach `WebSendService`
 *   to route a reply. Both directions must declare forwardRef or Nest
 *   cannot resolve the graph at boot.
 */
@Module({
  imports: [
    RateLimitModule,
    // Webhook fan-out for `message.received`, matching the other channels.
    forwardRef(() => V1Module),
    forwardRef(() => AutomationsModule),
    forwardRef(() => FlowsModule),
    forwardRef(() => AiModule),
    forwardRef(() => FormsModule),
  ],
  controllers: [
    WebConfigController,
    WebDashboardController,
    WebPublicController,
    WebStreamController,
  ],
  providers: [
    WebConfigService,
    WebSessionService,
    WebSendService,
    WebInboundService,
    WebStreamService,
    WebMediaService,
    WebSessionsService,
  ],
  exports: [WebConfigService, WebSendService, WebStreamService],
})
export class WebModule {}
