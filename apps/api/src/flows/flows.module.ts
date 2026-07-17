import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { InternalDispatchGuard } from '../automations/guards/internal-dispatch.guard';
import { FlowsController } from './flows.controller';
import { FlowsEngineController } from './flows-engine.controller';
import { FlowsService } from './flows.service';
import { FlowDispatchService } from './services/flow-dispatch.service';
import {
  FLOWS_SWEEP_QUEUE,
  FlowsSweepService,
} from './services/flows-sweep.service';
import { FlowsSweepProcessor } from './flows-sweep.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: FLOWS_SWEEP_QUEUE }),
    forwardRef(() => WhatsappModule),
  ],
  controllers: [FlowsController, FlowsEngineController],
  providers: [
    FlowsService,
    FlowDispatchService,
    FlowsSweepService,
    FlowsSweepProcessor,
    // Reused from the automations bridge — same class, same
    // INTERNAL_API_SECRET; registered here so this module's injector
    // can instantiate it for FlowsEngineController.
    InternalDispatchGuard,
  ],
  exports: [FlowDispatchService],
})
export class FlowsModule {}
