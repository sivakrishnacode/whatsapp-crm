import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';

import { WebConfigService } from '../services/web-config.service';
import {
  isOriginAllowed,
  looksLikeWidgetKey,
  normalizeOrigin,
} from '../utils/widget-key.util';

/** What this guard attaches for downstream handlers. */
export interface WidgetContext {
  accountId: string;
  /** Owning user — the "config owner" the AI and flow engines expect. */
  ownerUserId: string;
  widgetKey: string;
  /** Normalised request Origin, already confirmed against the allowlist. */
  origin: string;
}

export interface RequestWithWidget extends Request {
  widget: WidgetContext;
}

/**
 * The outer gate on every visitor-facing endpoint: resolve a public
 * widget key to an account, and confirm the request came from a site
 * that account allows.
 *
 * THIS IS NOT AUTHENTICATION
 *   The widget key is public — it is in the page source of the
 *   customer's own website. Passing this guard proves only "a browser on
 *   an allowed site is talking to us about this account". Anything that
 *   reads or writes a conversation needs `VisitorSessionGuard` on top,
 *   which requires a signed token this guard cannot produce.
 *
 * WHY ORIGIN, NOT CORS
 *   CORS asks the *browser* to enforce a rule and is trivially absent on
 *   a non-browser client. Checking `Origin` server-side and refusing is
 *   an actual access control. The widget reaches us same-origin through
 *   the Next rewrite anyway, so CORS would not even be consulted.
 *
 *   An `Origin` header is spoofable by a non-browser caller, so this is
 *   not a defence against a determined attacker with the public key — it
 *   is what stops a random site from embedding someone else's widget and
 *   what bounds abuse to sites the account named. The session token is
 *   what protects conversation data.
 */
@Injectable()
export class WidgetKeyGuard implements CanActivate {
  private readonly logger = new Logger(WidgetKeyGuard.name);

  constructor(private readonly config: WebConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithWidget>();

    const widgetKey = readWidgetKey(request);

    // Shape-checked before the DB read so a flood of junk keys cannot be
    // turned into a flood of indexed lookups.
    if (!looksLikeWidgetKey(widgetKey)) {
      throw new ForbiddenException('Unknown widget.');
    }

    const config = await this.config.findByWidgetKey(widgetKey);
    if (!config) {
      // Deliberately the same message and status as a bad shape: an
      // attacker must not be able to distinguish "this key exists" from
      // "it does not" and enumerate accounts.
      throw new ForbiddenException('Unknown widget.');
    }

    if (config.status === 'disabled') {
      throw new ForbiddenException('This chat widget is currently turned off.');
    }

    const rawOrigin = request.headers.origin ?? request.headers.referer;
    const isDev = process.env.NODE_ENV !== 'production';
    const effectiveOrigin = rawOrigin || (isDev ? 'http://localhost:3000' : undefined);
    const origin =
      normalizeOrigin(effectiveOrigin) ?? (isDev ? 'http://localhost:3000' : null);

    if (!origin || !isOriginAllowed(effectiveOrigin, config.allowedOrigins)) {
      this.logger.warn(
        `widget ${widgetKey.slice(0, 10)}… refused for origin ${String(rawOrigin)}`,
      );
      throw new ForbiddenException(
        config.allowedOrigins.length === 0
          ? 'This widget has no allowed domains configured yet.'
          : 'This domain is not allowed to load this chat widget.',
      );
    }

    request.widget = {
      accountId: config.accountId,
      ownerUserId: config.userId,
      widgetKey,
      origin,
    };
    return true;
  }
}

/**
 * The key may arrive in a header, a query param or a body field.
 *
 * All three exist for real reasons: the SSE endpoint is opened by
 * `EventSource`, which cannot set headers at all, so it must use the
 * query string. Ordinary XHR calls prefer the header. The body form
 * keeps `navigator.sendBeacon` usable for session-end pings.
 */
function readWidgetKey(request: Request): unknown {
  const header = request.headers['x-widget-key'];
  if (typeof header === 'string') return header;
  if (Array.isArray(header)) return header[0];

  const query = request.query?.widget_key;
  if (typeof query === 'string') return query;

  const body = request.body as Record<string, unknown> | undefined;
  return body?.widget_key;
}
