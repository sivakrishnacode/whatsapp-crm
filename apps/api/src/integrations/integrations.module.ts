import { Module } from '@nestjs/common';
import { ZapierController } from './controllers/zapier.controller';
import { FacebookController, FacebookLeadsWebhookController } from './controllers/facebook.controller';
import { V1Module } from '../v1/v1.module';

@Module({
  imports: [V1Module],
  controllers: [
    ZapierController,
    FacebookController,
    FacebookLeadsWebhookController,
  ],
})
export class IntegrationsModule {}
