import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MessagingModule } from '../common/messaging/messaging.module';
import { SegmentsModule } from '../common/segments/segments.module';
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
import { FlowsResumeProcessor } from './flows-resume.processor';
import { FlowWaitService } from './services/flow-wait.service';
import { FLOWS_RESUME_QUEUE } from '../queue/queue.constants';

@Module({
  imports: [
    BullModule.registerQueue({ name: FLOWS_SWEEP_QUEUE }),
    // One delayed job per run parked at a `wait` node.
    BullModule.registerQueue({ name: FLOWS_RESUME_QUEUE }),
    // ⚠️ Flows are WHATSAPP-ONLY. The Instagram and web webhooks no
    // longer dispatch into this engine — a flow can send a list, a
    // template or a catalogue, none of which exist off WhatsApp.
    // Automations remain the channel-agnostic engine.
    forwardRef(() => WhatsappModule),
    forwardRef(() => MessagingModule),
    // The set_segment node.
    SegmentsModule,
  ],
  controllers: [FlowsController, FlowsEngineController],
  providers: [
    FlowsService,
    FlowDispatchService,
    FlowsSweepService,
    FlowsSweepProcessor,
    FlowWaitService,
    FlowsResumeProcessor,
    // Reused from the automations bridge — same class, same
    // INTERNAL_API_SECRET; registered here so this module's injector
    // can instantiate it for FlowsEngineController.
    InternalDispatchGuard,
  ],
  exports: [FlowDispatchService],
})
export class FlowsModule {}
