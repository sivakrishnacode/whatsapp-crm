import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AutomationMetaSendService } from './automation-meta-send.service';
import { FlowMetaSendService } from './flow-meta-send.service';
import { ConnectAccountService } from './services/connect-account.service';
import { WhatsappWebhookService } from './services/whatsapp-webhook.service';
import { WhatsappWebhookController } from './controllers/whatsapp-webhook.controller';
import { WhatsappConnectController } from './controllers/whatsapp-connect.controller';
import { WhatsappTemplatesController } from './controllers/whatsapp-templates.controller';
import { WhatsappMediaController } from './controllers/whatsapp-media.controller';
import { WhatsappDashboardController } from './controllers/whatsapp-dashboard.controller';
import { WhatsappShopController } from './controllers/whatsapp-shop.controller';
import { WhatsappBroadcastsController } from './controllers/whatsapp-broadcasts.controller';
import {
  DashboardBroadcastService,
  BROADCASTS_QUEUE,
} from './services/dashboard-broadcast.service';
import { BroadcastsProcessor } from './broadcasts.processor';
import { V1Module } from '../v1/v1.module';
import { AutomationsModule } from '../automations/automations.module';
import { FlowsModule } from '../flows/flows.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    V1Module,
    BullModule.registerQueue({ name: BROADCASTS_QUEUE }),
    forwardRef(() => AutomationsModule),
    forwardRef(() => FlowsModule),
    forwardRef(() => AiModule),
  ],
  controllers: [
    WhatsappWebhookController,
    WhatsappConnectController,
    WhatsappTemplatesController,
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
    BroadcastsProcessor,
  ],
  exports: [
    AutomationMetaSendService,
    FlowMetaSendService,
    ConnectAccountService,
    WhatsappWebhookService,
  ],
})
export class WhatsappModule {}

