import { Module } from '@nestjs/common';
import { CtwaController } from './controllers/ctwa.controller';
import { CampaignSchedulesController } from './controllers/campaign-schedules.controller';

@Module({
  controllers: [CtwaController, CampaignSchedulesController],
})
export class CampaignsModule {}
