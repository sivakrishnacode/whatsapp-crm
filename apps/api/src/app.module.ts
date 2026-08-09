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
import { InstagramModule } from './instagram/instagram.module';
import { WebModule } from './web/web.module';
import { AccountModule } from './account/account.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { EcommerceModule } from './ecommerce/ecommerce.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { EntitlementModule } from './subscription/entitlement.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { AiModule } from './ai/ai.module';
import { FormsModule } from './forms/forms.module';
import { AdsModule } from './ads/ads.module';

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
    InstagramModule,
    WebModule,
    FormsModule,
    // Phase 5
    AccountModule,
    IntegrationsModule,
    EcommerceModule,
    CampaignsModule,
    // Global: @RequiresEntitlement() resolves EntitlementGuard from the
    // controller's module context, and gated routes live in eight of them.
    EntitlementModule,
    SubscriptionModule,
    OnboardingModule,
    AiModule,
    // Meta Ads Manager. Every route is behind ADS_MANAGER_ENABLED, so
    // importing it unconditionally is safe — see AdsEnabledGuard.
    AdsModule,
  ],
})
export class AppModule {}
