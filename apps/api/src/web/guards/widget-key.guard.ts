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
 *
 * THE WIDGET IS SAME-ORIGIN TO THIS API, NOT CROSS-ORIGIN
 *   Worth stating plainly, because assuming otherwise broke this guard in
 *   production. The frame is served from the app origin and calls
 *   `/api/public/web/*` on that same host, so most of its requests carry no
 *   `Origin` header at all. See the long note in `canActivate`.
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

    const rawOrigin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];

    /**
     * SAME-ORIGIN REQUESTS CARRY NO `Origin`, AND THAT IS THE NORMAL CASE
     *
     * An earlier version of this guard denied every request without an Origin
     * header, on the reasoning that "the widget is always cross-origin to this
     * API". That reasoning was wrong, and it took the widget down completely.
     *
     * The widget frame is served from THIS origin (app.…/widget/v1/frame) and
     * calls `/api/public/web/*` on the same host. Per the Fetch spec, browsers
     * send `Origin` for CORS requests and for non-GET/HEAD methods — but NOT
     * for same-origin GETs. So `GET /bootstrap`, `GET /messages` and the
     * EventSource stream all legitimately arrive with no Origin, while
     * `POST /session` arrives with one. The result was a widget where creating
     * a session worked and everything else 403'd.
     *
     * `Sec-Fetch-Site` is the right discriminator: browsers set it, page JS
     * cannot forge it. `same-origin` means the frame is talking to its own
     * host, which needs no allowlist check — the allowlist exists to stop
     * OTHER sites embedding the widget, and a same-origin call is by
     * definition not that.
     *
     * When the header is absent (older Safari, or a non-browser client) the
     * request is allowed through. That is a deliberate, bounded loosening:
     * a non-browser client can set any `Origin` it likes, so refusing a
     * missing one never protected against it. What the allowlist genuinely
     * protects is browser-embedded abuse, and browsers always send Origin
     * cross-origin. Volume abuse is bounded by the per-(key, ip) rate limits
     * on every route here, not by this check.
     */
    const isSameOrigin = fetchSite === 'same-origin';
    const crossSiteWithoutOrigin =
      !rawOrigin &&
      typeof fetchSite === 'string' &&
      fetchSite !== 'same-origin';

    if (!isSameOrigin) {
      // A browser that told us this is cross-site but sent no Origin is not a
      // shape `fetch()` produces — refuse rather than fall through.
      if (
        crossSiteWithoutOrigin ||
        (rawOrigin && !isOriginAllowed(rawOrigin, config.allowedOrigins))
      ) {
        this.logger.warn(
          `widget ${widgetKey.slice(0, 10)}… refused for origin ${String(rawOrigin)} (sec-fetch-site=${String(fetchSite)})`,
        );
        throw new ForbiddenException(
          config.allowedOrigins.length === 0
            ? 'This widget has no allowed domains configured yet.'
            : 'This domain is not allowed to load this chat widget.',
        );
      }
    }

    // Normalised where we have one; the frame's own origin otherwise. Only
    // ever used for logging and session attribution, never re-checked.
    const origin = normalizeOrigin(rawOrigin) ?? 'same-origin';

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
