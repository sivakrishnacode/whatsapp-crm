import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MessagingModule } from '../common/messaging/messaging.module';
import { AiController } from './controllers/ai.controller';
import { AgentController } from './controllers/agent.controller';
import { AgentActionsController } from './controllers/agent-actions.controller';
import { AiKnowledgeController } from './controllers/ai-knowledge.controller';
import { AiReplyService } from './services/ai-reply.service';
import { AgentConfigService } from './services/agent-config.service';
import { AgentRuntimeService } from './services/agent-runtime.service';
import { AgentActionsService } from './services/agent-actions.service';
import { KnowledgeSourceService } from './services/knowledge-source.service';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => WhatsappModule),
    // The auto-reply bot sends through ChannelSenderService so it works
    // on Instagram DMs as well as WhatsApp.
    forwardRef(() => MessagingModule),
  ],
  controllers: [
    AiController,
    AgentController,
    AgentActionsController,
    AiKnowledgeController,
  ],
  providers: [
    AiReplyService,
    AgentConfigService,
    AgentRuntimeService,
    AgentActionsService,
    KnowledgeSourceService,
  ],
  exports: [AiReplyService],
})
export class AiModule {}
