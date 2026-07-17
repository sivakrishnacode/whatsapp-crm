import { Module, forwardRef } from '@nestjs/common';
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
import { V1Module } from '../v1/v1.module';
import { AutomationsModule } from '../automations/automations.module';
import { FlowsModule } from '../flows/flows.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    V1Module,
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
  ],
  providers: [
    AutomationMetaSendService,
    FlowMetaSendService,
    ConnectAccountService,
    WhatsappWebhookService,
  ],
  exports: [
    AutomationMetaSendService,
    FlowMetaSendService,
    ConnectAccountService,
    WhatsappWebhookService,
  ],
})
export class WhatsappModule {}

