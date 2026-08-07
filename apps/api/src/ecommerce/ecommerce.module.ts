import { Module } from '@nestjs/common';
import { EcommerceController } from './controllers/ecommerce.controller';
import { EcommerceSyncService } from './services/ecommerce-sync.service';
import { EcommerceSyncProcessor } from './queues/ecommerce-sync.processor';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [QueueModule],
  controllers: [EcommerceController],
  providers: [EcommerceSyncService, EcommerceSyncProcessor],
})
export class EcommerceModule {}
