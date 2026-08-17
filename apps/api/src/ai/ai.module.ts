import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MessagingModule } from '../common/messaging/messaging.module';
import { AiController } from './controllers/ai.controller';
import { AgentsController } from './controllers/agents.controller';
import { AgentActionsController } from './controllers/agent-actions.controller';
import { AiKnowledgeController } from './controllers/ai-knowledge.controller';
import { AutomationDraftController } from './controllers/automation-draft.controller';
import { FlowDraftController } from './controllers/flow-draft.controller';
import { AiReplyService } from './services/ai-reply.service';
import { AgentConfigService } from './services/agent-config.service';
import { AgentsService } from './services/agents.service';
import { AgentResolverService } from './services/agent-resolver.service';
import { AgentRuntimeService } from './services/agent-runtime.service';
import { AgentActionsService } from './services/agent-actions.service';
import { KnowledgeSourceService } from './services/knowledge-source.service';
import { AgentDealsService } from './services/agent-deals.service';
import { AgentFeaturesService } from './services/agent-features.service';
import { QueueModule } from '../queue/queue.module';
import { AiReplyProcessor } from './queues/ai-reply.processor';
import { AiCreditsModule } from './credits/ai-credits.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => WhatsappModule),
    // The auto-reply bot sends through ChannelSenderService so it works
    // on Instagram DMs as well as WhatsApp.
    forwardRef(() => MessagingModule),
    // Inbound messages are answered on a queue, not in the webhook.
    QueueModule,
    // Metering. Every entry point that calls a provider on OUR key
    // charges through this.
    AiCreditsModule,
  ],
  controllers: [
    AiController,
    AgentsController,
    AgentActionsController,
    AiKnowledgeController,
    AutomationDraftController,
    FlowDraftController,
  ],
  providers: [
    AiReplyService,
    AiReplyProcessor,
    AgentConfigService,
    AgentsService,
    AgentResolverService,
    AgentRuntimeService,
    AgentActionsService,
    KnowledgeSourceService,
    AgentDealsService,
    AgentFeaturesService,
  ],
  exports: [AiReplyService],
})
export class AiModule {}
