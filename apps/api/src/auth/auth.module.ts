import { Global, Module } from '@nestjs/common';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { ApiKeyGuard } from './guards/api-key.guard';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';

@Global()
@Module({
  imports: [RateLimitModule],
  providers: [ApiKeyGuard, SupabaseAuthGuard],
  exports: [ApiKeyGuard, SupabaseAuthGuard],
})
export class AuthModule {}
