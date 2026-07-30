import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { WebConfigService } from '../services/web-config.service';
import {
  VisitorTokenError,
  verifyVisitorToken,
  type VisitorTokenClaims,
} from '../utils/visitor-token.util';
import type { RequestWithWidget } from './widget-key.guard';

export interface RequestWithVisitor extends RequestWithWidget {
  visitor: VisitorTokenClaims;
}

/**
 * The inner gate: proves the caller owns the conversation it is about to
 * read or write.
 *
 * ALWAYS PAIRED WITH WidgetKeyGuard, AND ALWAYS SECOND
 *   It needs `request.widget.accountId` to know whose secret to verify
 *   against, so it cannot run first. Nest applies `@UseGuards(A, B)` in
 *   order, which is what makes the pairing work.
 *
 * THE CROSS-TENANT CHECK IS EXPLICIT ANYWAY
 *   Verifying against the account's own secret already makes a token
 *   from another account fail. The `accountId` comparison below is
 *   therefore redundant *today* — it is here because the day someone
 *   introduces a shared fallback secret, or caches a verification, the
 *   signature stops carrying that guarantee and this line becomes the
 *   only thing standing between two tenants' conversations. It costs a
 *   string compare.
 */
@Injectable()
export class VisitorSessionGuard implements CanActivate {
  constructor(private readonly config: WebConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithVisitor>();

    if (!request.widget?.accountId) {
      // A wiring mistake, not a client error: this guard was applied
      // without WidgetKeyGuard in front of it. Fail loudly rather than
      // silently admitting the request.
      throw new UnauthorizedException('Widget context missing.');
    }

    const token = readSessionToken(request);
    if (!token) {
      throw new UnauthorizedException('No chat session.');
    }

    const secret = await this.config.loadSigningSecret(
      request.widget.accountId,
    );

    let claims: VisitorTokenClaims;
    try {
      claims = await verifyVisitorToken(token, secret);
    } catch (err) {
      if (err instanceof VisitorTokenError) {
        // The reason rides along in the body so the widget can tell
        // "start a new session" from "stop retrying" without parsing
        // the message text.
        throw new UnauthorizedException({
          message: err.message,
          reason: err.reason,
        });
      }
      throw err;
    }

    if (claims.accountId !== request.widget.accountId) {
      throw new UnauthorizedException(
        'Session does not belong to this widget.',
      );
    }

    request.visitor = claims;
    return true;
  }
}

/**
 * Bearer header for XHR; query param for `EventSource`, which cannot set
 * headers.
 */
function readSessionToken(request: RequestWithVisitor): string | null {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim() || null;
  }

  const query = request.query?.session;
  if (typeof query === 'string' && query) return query;

  const body = request.body as Record<string, unknown> | undefined;
  const fromBody = body?.session_token;
  return typeof fromBody === 'string' && fromBody ? fromBody : null;
}
