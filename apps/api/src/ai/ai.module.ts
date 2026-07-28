import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MessagingModule } from '../common/messaging/messaging.module';
import { AiController } from './controllers/ai.controller';
import { AiReplyService } from './services/ai-reply.service';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => WhatsappModule),
    // The auto-reply bot sends through ChannelSenderService so it works
    // on Instagram DMs as well as WhatsApp.
    forwardRef(() => MessagingModule),
  ],
  controllers: [AiController],
  providers: [AiReplyService],
  exports: [AiReplyService],
})
export class AiModule {}
