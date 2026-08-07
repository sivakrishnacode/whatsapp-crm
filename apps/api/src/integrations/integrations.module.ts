import { Module } from '@nestjs/common';
import { ZapierController } from './controllers/zapier.controller';
import {
  FacebookController,
  FacebookLeadsWebhookController,
} from './controllers/facebook.controller';
import { FacebookLeadService } from './services/facebook-lead.service';
import { LeadFetchProcessor } from './queues/lead-fetch.processor';
import { V1Module } from '../v1/v1.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [V1Module, QueueModule],
  controllers: [
    ZapierController,
    FacebookController,
    FacebookLeadsWebhookController,
  ],
  providers: [FacebookLeadService, LeadFetchProcessor],
})
export class IntegrationsModule {}
