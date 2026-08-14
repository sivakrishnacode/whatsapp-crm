import { Controller, Get, Query, Res, Logger } from '@nestjs/common';
import type * as express from 'express';
import { OAuthFlowService } from '../services/oauth-flow.service';
import { decodeConnectionsState } from '../utils/connections-oauth-state.util';

/**
 * The provider's redirect back.
 *
 * ⚠️ NO AUTH GUARD, DELIBERATELY — same as `ads/oauth/callback`.
 *   This is a top-level cross-site GET arriving from accounts.google.com.
 *   No session cookie can be relied on (SameSite), so a guard here would
 *   reject every legitimate callback.
 *
 *   Authorisation is the HMAC-signed `state`: it carries the accountId
 *   and userId that started the flow and is signed with
 *   CONNECTIONS_STATE_SECRET. A forged, replayed or expired state
 *   decodes to null and the flow aborts. That binding is what stops an
 *   attacker starting a connect flow and feeding the callback URL to
 *   someone logged into a different workspace — the connection can only
 *   ever be written to the account that began it.
 */
@Controller('connections/oauth')
export class ConnectionsOAuthController {
  private readonly logger = new Logger(ConnectionsOAuthController.name);

  constructor(private readonly oauth: OAuthFlowService) {}

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: express.Response,
  ) {
    // ⚠️ The landing page is built from OUR OWN config, never from the
    // query string. This URL round-trips through accounts.google.com, so
    // a free-form redirect target would be an open redirect wearing a
    // Google referrer.
    const base = process.env.APP_URL ?? 'http://localhost:3000';
    const landing = `${base}/integrations`;

    const fail = (reason: string) =>
      res.redirect(`${landing}?connect_error=${encodeURIComponent(reason)}`);

    if (error) {
      // Almost always the user pressing Cancel on the consent screen.
      return fail(
        error === 'access_denied' ? 'You cancelled the connection.' : error,
      );
    }
    if (!state) return fail('Missing state. Please start again.');
    if (!code) return fail('Google did not return an authorization code.');

    const decoded = decodeConnectionsState(state);
    if (!decoded) {
      // Tampered, expired (10 min) or signed with a different secret.
      // Never "proceed with defaults" — there is no safe default for
      // "which workspace does this Google account belong to".
      return fail('That connection link has expired. Please start again.');
    }

    try {
      const { displayName } = await this.oauth.completeCallback({
        state: decoded,
        code,
      });

      // returnTo is a PATH from our own app, chosen by the code that
      // started the flow — but it still came back through Google, so it
      // is treated as untrusted: relative paths only, no protocol, no
      // protocol-relative "//evil.test".
      const target = safeReturnPath(decoded.returnTo)
        ? `${base}${decoded.returnTo}`
        : landing;

      const separator = target.includes('?') ? '&' : '?';
      return res.redirect(
        `${target}${separator}connected=${encodeURIComponent(displayName ?? 'google')}`,
      );
    } catch (err) {
      this.logger.warn(
        `Connection callback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fail(
        err instanceof Error
          ? err.message
          : 'Could not complete the connection.',
      );
    }
  }
}

/** Same shape as the web app's `sanitizeNextPath`: our own paths only. */
function safeReturnPath(path: string | undefined): path is string {
  return Boolean(path) && /^\/[^/\\]/.test(path!);
}
