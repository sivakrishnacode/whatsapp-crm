import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AccountContext } from '../types/account-context.type';

export interface RequestWithAccountContext extends Request {
  accountContext: AccountContext;
}

/** Reads the context a guard (SupabaseAuthGuard/ApiKeyGuard) attached to the request. */
export const CurrentAccount = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccountContext => {
    const request = ctx.switchToHttp().getRequest<RequestWithAccountContext>();
    return request.accountContext;
  },
);
