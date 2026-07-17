import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { RateLimitOptions, RateLimitResult } from './rate-limit.types';

/**
 * Fixed-window counter backed by the self-hosted Redis instance
 * (apps/web's Upstash-REST limiter stays separate — see docker-compose.yml
 * and apps/api/.env.example). One INCR + conditional PEXPIRE per call, so a
 * key's window starts on its first hit and expires on its own.
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async check(
    key: string,
    { limit, windowMs }: RateLimitOptions,
  ): Promise<RateLimitResult> {
    const redisKey = `ratelimit:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.pexpire(redisKey, windowMs);
    }
    const ttl = await this.redis.pttl(redisKey);
    const reset = Date.now() + Math.max(ttl, 0);

    return {
      success: count <= limit,
      remaining: Math.max(limit - count, 0),
      reset,
      limit,
    };
  }
}
