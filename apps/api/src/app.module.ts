import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { AutomationsModule } from './automations/automations.module';
import { FlowsModule } from './flows/flows.module';
import { V1Module } from './v1/v1.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { AccountModule } from './account/account.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { EcommerceModule } from './ecommerce/ecommerce.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    QueueModule,
    AuthModule,
    HealthModule,
    AutomationsModule,
    FlowsModule,
    V1Module,
    WhatsappModule,
    // Phase 5
    AccountModule,
    IntegrationsModule,
    EcommerceModule,
    CampaignsModule,
    SubscriptionModule,
    AiModule,
  ],
})
export class AppModule {}


