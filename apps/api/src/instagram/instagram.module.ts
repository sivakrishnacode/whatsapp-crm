import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { InstagramWebhookController } from './controllers/instagram-webhook.controller';
import { InstagramConnectController } from './controllers/instagram-connect.controller';
import { InstagramDashboardController } from './controllers/instagram-dashboard.controller';
import { InstagramCommentsController } from './controllers/instagram-comments.controller';
import { InstagramFunnelsController } from './controllers/instagram-funnels.controller';

import { InstagramConnectService } from './services/instagram-connect.service';
import { InstagramIdentityService } from './services/instagram-identity.service';
import { InstagramMediaMirrorService } from './services/instagram-media-mirror.service';
import { InstagramWebhookService } from './services/instagram-webhook.service';
import { InstagramSendService } from './services/instagram-send.service';
import { InstagramCommentsService } from './services/instagram-comments.service';
import { CommentFunnelService } from './services/comment-funnel.service';
import {
  InstagramTokenRefreshService,
  IG_TOKEN_QUEUE,
} from './services/instagram-token-refresh.service';
import { InstagramTokenRefreshProcessor } from './processors/instagram-token-refresh.processor';

import { V1Module } from '../v1/v1.module';
import { AutomationsModule } from '../automations/automations.module';
import { FlowsModule } from '../flows/flows.module';
import { AiModule } from '../ai/ai.module';

/**
 * Instagram DM + comment moderation.
 *
 * Structured to mirror WhatsappModule so the two channels are
 * diffable, and imports the same three engines — the webhook hands
 * every inbound to flows, automations and the AI bot exactly as the
 * WhatsApp one does.
 *
 * The forwardRef trio is load-bearing, not defensive: AiModule imports
 * this module back (via ChannelSenderService, which has to reach
 * InstagramSendService to route a reply to the right platform), so
 * without it Nest cannot resolve the cycle at boot.
 */
@Module({
  imports: [
    // forwardRef, unlike WhatsappModule's plain V1Module import: V1Module
    // imports THIS module back, so POST /v1/messages can route Instagram
    // conversations to InstagramSendService. That makes it a real cycle
    // and both sides have to declare it.
    forwardRef(() => V1Module),
    BullModule.registerQueue({ name: IG_TOKEN_QUEUE }),
    forwardRef(() => AutomationsModule),
    forwardRef(() => FlowsModule),
    forwardRef(() => AiModule),
  ],
  controllers: [
    InstagramWebhookController,
    InstagramConnectController,
    InstagramDashboardController,
    InstagramCommentsController,
    InstagramFunnelsController,
  ],
  providers: [
    InstagramConnectService,
    InstagramIdentityService,
    InstagramMediaMirrorService,
    InstagramWebhookService,
    InstagramSendService,
    InstagramCommentsService,
    CommentFunnelService,
    InstagramTokenRefreshService,
    InstagramTokenRefreshProcessor,
  ],
  exports: [
    InstagramConnectService,
    InstagramSendService,
    InstagramCommentsService,
    InstagramTokenRefreshService,
  ],
})
export class InstagramModule {}
