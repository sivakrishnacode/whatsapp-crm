import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AiController } from './controllers/ai.controller';
import { AiReplyService } from './services/ai-reply.service';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => WhatsappModule),
  ],
  controllers: [AiController],
  providers: [AiReplyService],
  exports: [AiReplyService],
})
export class AiModule {}
