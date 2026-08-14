import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MessagingModule } from '../common/messaging/messaging.module';
import { SegmentsModule } from '../common/segments/segments.module';
import { FlowsModule } from '../flows/flows.module';
import { ConnectionsModule } from '../connections/connections.module';
import { AutomationsController } from './automations.controller';
import { AutomationsEngineController } from './automations-engine.controller';
import { AutomationsService } from './automations.service';
import { AutomationDispatchService } from './services/automation-dispatch.service';
import {
  AUTOMATIONS_PENDING_QUEUE,
  AutomationStepExecutorService,
} from './services/automation-step-executor.service';
import { AutomationConditionService } from './services/automation-condition.service';
import { AutomationStepPreviewService } from './services/automation-step-preview.service';
import { AutomationStepsTreeService } from './services/automation-steps-tree.service';
import { AutomationsProcessor } from './automations.processor';
import { InternalDispatchGuard } from './guards/internal-dispatch.guard';
import { AutomationTriggerProcessor } from './queues/automation-trigger.processor';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: AUTOMATIONS_PENDING_QUEUE }),
    // automation-trigger (starting a run) is registered centrally —
    // forms, the web widget and bookings all enqueue into it.
    QueueModule,
    forwardRef(() => WhatsappModule),
    // send_message steps route by conversation channel; send_template
    // steps use it to refuse cleanly on Instagram.
    forwardRef(() => MessagingModule),
    // add_to_segment / remove_from_segment. No forwardRef: SegmentsModule
    // depends on Prisma alone and sits below the engines.
    SegmentsModule,
    // The `start_flow` step. forwardRef because the two engines now
    // reference each other: the flow runner already reports back to the
    // webhook that decides whether automations also fire.
    forwardRef(() => FlowsModule),
    // The `app_action` step. No forwardRef: ConnectionsModule depends on
    // Prisma alone and knows nothing about automations, so it sits below
    // this one the same way SegmentsModule does.
    ConnectionsModule,
  ],
  controllers: [AutomationsController, AutomationsEngineController],
  providers: [
    AutomationsService,
    AutomationStepsTreeService,
    AutomationDispatchService,
    AutomationStepExecutorService,
    AutomationConditionService,
    AutomationStepPreviewService,
    AutomationsProcessor,
    AutomationTriggerProcessor,
    InternalDispatchGuard,
  ],
  exports: [AutomationDispatchService],
})
export class AutomationsModule {}
