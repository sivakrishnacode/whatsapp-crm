import { Module } from '@nestjs/common';
import { AutomationMetaSendService } from './automation-meta-send.service';
import { FlowMetaSendService } from './flow-meta-send.service';

@Module({
  providers: [AutomationMetaSendService, FlowMetaSendService],
  exports: [AutomationMetaSendService, FlowMetaSendService],
})
export class WhatsappModule {}
