import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { HumanTakeoverService } from './human-takeover.service';

/**
 * Conversation-level cross-channel concerns.
 *
 * Depends on Prisma and nothing else, so the three channel modules and
 * the Instagram webhook can all import it without any of the forwardRef
 * gymnastics the messaging module needs — it sits below them rather
 * than beside them.
 */
@Module({
  imports: [PrismaModule],
  providers: [HumanTakeoverService],
  exports: [HumanTakeoverService],
})
export class ConversationsModule {}
