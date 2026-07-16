import { Module } from '@nestjs/common';
import { AutomationMetaSendService } from './automation-meta-send.service';

@Module({
  providers: [AutomationMetaSendService],
  exports: [AutomationMetaSendService],
})
export class WhatsappModule {}
