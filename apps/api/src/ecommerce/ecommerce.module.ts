import { Module } from '@nestjs/common';
import { EcommerceController } from './controllers/ecommerce.controller';

@Module({
  controllers: [EcommerceController],
})
export class EcommerceModule {}
