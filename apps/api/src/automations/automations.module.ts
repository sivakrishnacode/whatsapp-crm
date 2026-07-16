import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
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

@Module({
  imports: [
    BullModule.registerQueue({ name: AUTOMATIONS_PENDING_QUEUE }),
    WhatsappModule,
  ],
  controllers: [AutomationsController, AutomationsEngineController],
  providers: [
    AutomationsService,
    AutomationStepsTreeService,
    AutomationDispatchService,
    AutomationStepExecutorService,
    AutomationConditionService,
    AutomationsProcessor,
    InternalDispatchGuard,
  ],
})
export class AutomationsModule {}
