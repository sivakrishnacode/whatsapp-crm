import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Machine-to-machine auth for apps/web's webhook -> apps/api bridge
 * (POST /internal/automations/dispatch). Mirrors the existing
 * `x-cron-secret` pattern (apps/web's automations/flows cron routes):
 * a shared secret header, compared in constant time, length-checked
 * first since `timingSafeEqual` throws on a length mismatch rather
 * than returning false.
 */
@Injectable()
export class InternalDispatchGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = process.env.INTERNAL_API_SECRET;
    if (!expected) {
      throw new UnauthorizedException();
    }

    const supplied = request.headers['x-internal-secret'];
    const suppliedStr = typeof supplied === 'string' ? supplied : '';
    const suppliedBuf = Buffer.from(suppliedStr);
    const expectedBuf = Buffer.from(expected);
    if (
      suppliedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(suppliedBuf, expectedBuf)
    ) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
