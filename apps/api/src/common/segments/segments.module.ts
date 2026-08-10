import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SegmentMembershipService } from './segment-membership.service';

/**
 * Segment membership, shared by every surface that can file somebody
 * into an audience: the automation step, the flow node, the broadcast
 * audience resolver and the public v1 API.
 *
 * No forwardRef anywhere — this depends on Prisma and nothing else, on
 * purpose. It sits below the engines rather than beside them, so
 * importing it can never be the thing that creates a cycle.
 */
@Module({
  imports: [PrismaModule],
  providers: [SegmentMembershipService],
  exports: [SegmentMembershipService],
})
export class SegmentsModule {}
