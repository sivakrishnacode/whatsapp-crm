import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SegmentsModule } from '../common/segments/segments.module';
import { AutomationMetaSendService } from './automation-meta-send.service';
import { FlowMetaSendService } from './flow-meta-send.service';
import { ConnectAccountService } from './services/connect-account.service';
import { WhatsappWebhookService } from './services/whatsapp-webhook.service';
import { WhatsappWebhookController } from './controllers/whatsapp-webhook.controller';
import { WhatsappConnectController } from './controllers/whatsapp-connect.controller';
import { WhatsappTemplatesController } from './controllers/whatsapp-templates.controller';
import { WhatsappFlowsController } from './controllers/whatsapp-flows.controller';
import { WhatsappMediaController } from './controllers/whatsapp-media.controller';
import { WhatsappDashboardController } from './controllers/whatsapp-dashboard.controller';
import { WhatsappShopController } from './controllers/whatsapp-shop.controller';
import { WhatsappBroadcastsController } from './controllers/whatsapp-broadcasts.controller';
import { DashboardBroadcastService } from './services/dashboard-broadcast.service';
import { BroadcastOrchestratorProcessor } from './queues/broadcast-orchestrator.processor';
import { BroadcastSendProcessor } from './queues/broadcast-send.processor';
import { BroadcastRecipientSendService } from './queues/broadcast-recipient-send.service';
import { BroadcastFinalizeService } from './queues/broadcast-finalize.service';
import { BroadcastRecoveryService } from './queues/broadcast-recovery.service';
import {
  MessagingLimitsService,
  LIMITS_QUEUE,
} from './services/messaging-limits.service';
import { MessagingLimitsProcessor } from './messaging-limits.processor';
import { QueueModule } from '../queue/queue.module';
import { V1Module } from '../v1/v1.module';
import { AutomationsModule } from '../automations/automations.module';
import { FlowsModule } from '../flows/flows.module';
import { AiModule } from '../ai/ai.module';
import { ConversationsModule } from '../common/conversations/conversations.module';

@Module({
  imports: [
    // Pauses the AI bot when a human replies (HumanTakeoverService).
    ConversationsModule,
    V1Module,
    // Broadcast queues (orchestrate + send) are registered centrally —
    // the public API enqueues into the same ones. See QueueModule.
    QueueModule,
    BullModule.registerQueue({ name: LIMITS_QUEUE }),
    forwardRef(() => AutomationsModule),
    forwardRef(() => FlowsModule),
    forwardRef(() => AiModule),
    // Broadcast audiences can be a saved segment.
    SegmentsModule,
  ],
  controllers: [
    WhatsappWebhookController,
    WhatsappConnectController,
    WhatsappTemplatesController,
    WhatsappFlowsController,
    WhatsappMediaController,
    WhatsappDashboardController,
    WhatsappShopController,
    WhatsappBroadcastsController,
  ],
  providers: [
    AutomationMetaSendService,
    FlowMetaSendService,
    ConnectAccountService,
    WhatsappWebhookService,
    DashboardBroadcastService,
    BroadcastOrchestratorProcessor,
    BroadcastSendProcessor,
    BroadcastRecipientSendService,
    BroadcastFinalizeService,
    BroadcastRecoveryService,
    MessagingLimitsService,
    MessagingLimitsProcessor,
  ],
  exports: [
    AutomationMetaSendService,
    FlowMetaSendService,
    ConnectAccountService,
    WhatsappWebhookService,
    MessagingLimitsService,
  ],
})
export class WhatsappModule {}
