import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckError,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.constants';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { RequireScope } from '../auth/decorators/require-scope.decorator';
import { CurrentAccount } from '../auth/decorators/current-account.decorator';
import type { AccountContext } from '../auth/types/account-context.type';

/**
 * Diagnostic-only endpoints for Phase 0 — not business routes.
 * `/health` is the Docker/uptime healthcheck; the two `whoami` routes
 * are the acceptance test proving each guard resolves a real
 * account against the live Supabase DB via Prisma.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.checkPrisma(),
      () => this.checkRedis(),
    ]);
  }

  @Get('whoami')
  @UseGuards(SupabaseAuthGuard)
  whoami(@CurrentAccount() account: AccountContext) {
    return account;
  }

  @Get('whoami/api-key')
  @UseGuards(ApiKeyGuard)
  @RequireScope('messages:read')
  whoamiApiKey(@CurrentAccount() account: AccountContext) {
    return account;
  }

  private async checkPrisma(): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { prisma: { status: 'up' } };
    } catch (err) {
      throw new HealthCheckError('Prisma check failed', {
        prisma: { status: 'down', message: (err as Error).message },
      });
    }
  }

  private async checkRedis(): Promise<HealthIndicatorResult> {
    try {
      // ioredis types ping()'s resolved value as the literal 'PONG' — a
      // connection failure rejects the promise instead, caught below.
      await this.redis.ping();
      return { redis: { status: 'up' } };
    } catch (err) {
      throw new HealthCheckError('Redis check failed', {
        redis: { status: 'down', message: (err as Error).message },
      });
    }
  }
}
