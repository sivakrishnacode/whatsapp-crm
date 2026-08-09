import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  EntitlementService,
  type LimitType,
} from '../services/entitlement.service';
import type { AccountContext } from '../../auth/types/account-context.type';

/**
 * ============================================================
 * The entitlement gate.
 *
 * Declarative rather than an `if` at the top of each handler, because the
 * failure mode of the `if` version is silence: a new send route ships
 * without the check and nobody notices until an unpaid account has sent
 * ten thousand messages. `@RequiresEntitlement('messages')` on the route
 * is visible in review and greppable.
 *
 * WHERE IT GOES — the places that cost money or grow the plan:
 * outbound sends, broadcast enqueue, contact creation and import, flow
 * activation, teammate invites. Deliberately NOT on reads. The posture is
 * read-only-then-block: a lapsed workspace keeps its inbox, its contacts
 * and its history, and loses the things that spend. Locking someone out
 * of conversations they had with their own customers is not a collection
 * strategy.
 *
 * IT RUNS AFTER THE AUTH GUARD. `accountContext` is attached by
 * SupabaseAuthGuard or ApiKeyGuard, and Nest runs controller-level guards
 * before route-level ones — which is where `applyDecorators` puts this.
 * Both auth surfaces carry an `accountId`, so one gate covers the
 * dashboard and the public API without knowing which it is serving.
 * ============================================================
 */

export const ENTITLEMENT_KEY = 'requiresEntitlement';

interface EntitlementMeta {
  limit: LimitType;
  amount: number;
}

/**
 * Gate a route on one plan limit.
 *
 * `amount` is fixed at declaration time, which suits every one-unit
 * check. A cost known only at runtime — a broadcast's recipient count —
 * is checked inside the service that knows it, by calling
 * `EntitlementService.checkLimit` with the real number. A guard cannot
 * work that count out without doing the query the handler is about to do
 * anyway.
 */
export function RequiresEntitlement(limit: LimitType, amount = 1) {
  return applyDecorators(
    SetMetadata(ENTITLEMENT_KEY, { limit, amount } satisfies EntitlementMeta),
    UseGuards(EntitlementGuard),
  );
}

interface RequestWithContext extends Request {
  accountContext?: AccountContext;
}

@Injectable()
export class EntitlementGuard implements CanActivate {
  private readonly logger = new Logger(EntitlementGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<EntitlementMeta | undefined>(
      ENTITLEMENT_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No declaration means this guard was applied without a limit. Let it
    // through rather than inventing one: guarding a route against nothing
    // in particular is how a gate ends up blocking the wrong thing.
    if (!meta) return true;

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const accountId = request.accountContext?.accountId;

    if (!accountId) {
      // The auth guard should have run first. If it somehow did not, this
      // is not the place to decide who the caller is.
      this.logger.warn(
        `[entitlement] no account context on ${request.method} ${request.url}; skipping check`,
      );
      return true;
    }

    const check = await this.entitlements.checkLimit(
      accountId,
      meta.limit,
      meta.amount,
    );

    if (check.allowed) return true;

    // 402 rather than 403: nothing is wrong with who they are, and the
    // fix is a payment. Matches the AI credit path, which already returns
    // 402 with a code the web app knows how to render.
    throw new HttpException(
      {
        error: this.entitlements.refusalMessage(meta.limit, check),
        code:
          check.reason === 'subscription_lapsed'
            ? 'subscription_lapsed'
            : 'plan_limit_reached',
        limit: meta.limit,
        used: check.currentUsage,
        max: check.limitValue,
        standing: check.standing,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
