import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MessagingModule } from '../common/messaging/messaging.module';
import { AutomationsController } from './automations.controller';
import { AutomationsEngineController } from './automations-engine.controller';
import { AutomationsService } from './automations.service';
import { AutomationDispatchService } from './services/automation-dispatch.service';
import {
  AUTOMATIONS_PENDING_QUEUE,
  AutomationStepExecutorService,
} from './services/automation-step-executor.service';
import { AutomationConditionService } from './services/automation-condition.service';
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
  ],
  controllers: [AutomationsController, AutomationsEngineController],
  providers: [
    AutomationsService,
    AutomationStepsTreeService,
    AutomationDispatchService,
    AutomationStepExecutorService,
    AutomationConditionService,
    AutomationsProcessor,
    AutomationTriggerProcessor,
    InternalDispatchGuard,
  ],
  exports: [AutomationDispatchService],
})
export class AutomationsModule {}
