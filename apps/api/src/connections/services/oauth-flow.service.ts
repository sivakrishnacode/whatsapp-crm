import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt } from '../../common/security/encryption.util';
import {
  encodeConnectionsState,
  type ConnectionsOAuthPayload,
} from '../utils/connections-oauth-state.util';
import {
  fetchGoogleIdentity,
  googleOAuthConfig,
  GOOGLE_ALLOWED_SCOPES,
  GOOGLE_AUTH_URL,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_TOKEN_URL,
} from '../connectors/google/google.oauth';

/**
 * The OAuth redirect dance: build the authorize URL, then turn the code
 * that comes back into a stored connection.
 *
 * SERVER-SIDE REDIRECT, NOT A JS SDK
 *   Same decision as the Ads Manager connect flow. A Google token must
 *   never exist in page JavaScript, and `accounts.google.com` is absent
 *   from the web app's CSP `script-src`. The browser only ever sees a
 *   302 out and a 302 back.
 *
 * INCREMENTAL CONSENT
 *   `include_granted_scopes=true` means a second connect for Calendar
 *   returns a token covering Sheets AND Calendar, rather than replacing
 *   the first grant. That is what lets an action ask for exactly the
 *   scope it needs, when it needs it, instead of a consent screen that
 *   demands everything up front and gets declined.
 */
@Injectable()
export class OAuthFlowService {
  private readonly logger = new Logger(OAuthFlowService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Where to send the browser, plus the signed state that authorises the
   * callback.
   *
   * ⚠️ `requestedScopes` is attacker-influenceable (it comes off a query
   * string), so it is filtered against GOOGLE_ALLOWED_SCOPES. Without
   * that, a crafted link could ask a user to grant `gmail.readonly` —
   * which we are not verified for, would not expect, and which would put
   * the whole project on the CASA track if it ever succeeded.
   */
  buildAuthorizeUrl(args: {
    provider: string;
    accountId: string;
    userId: string;
    requestedScopes: string[];
    returnTo?: string;
  }): string {
    if (args.provider !== 'google') {
      throw new BadRequestException(`Unknown provider "${args.provider}".`);
    }

    const { clientId, redirectUri } = googleOAuthConfig();

    const scopes = Array.from(
      new Set([
        ...GOOGLE_IDENTITY_SCOPES,
        ...args.requestedScopes.filter((s) => GOOGLE_ALLOWED_SCOPES.has(s)),
      ]),
    );

    // PKCE. The code lands on a URL that may sit in browser history and
    // in any proxy log between here and Google; the verifier is what
    // makes an intercepted code useless on its own.
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const state = encodeConnectionsState({
      accountId: args.accountId,
      userId: args.userId,
      returnTo: args.returnTo,
      provider: args.provider,
      codeVerifier,
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // offline + consent is what produces a refresh token at all. Without
    // `prompt=consent`, a user who has connected before gets an access
    // token and no refresh token, and the connection dies in an hour
    // with no way to renew it.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');

    return url.toString();
  }

  /**
   * Turn the authorization code into a stored connection.
   *
   * Returns the connection id and the display name so the callback can
   * redirect somewhere useful.
   */
  async completeCallback(args: {
    state: ConnectionsOAuthPayload;
    code: string;
  }): Promise<{ connectionId: string; displayName: string | null }> {
    const { clientId, clientSecret, redirectUri } = googleOAuthConfig();

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: args.code,
        code_verifier: args.state.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
      redirect: 'manual',
    });

    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!res.ok || !body.access_token) {
      const reason =
        body.error_description ?? body.error ?? `HTTP ${res.status}`;
      this.logger.warn(`Google code exchange failed: ${reason}`);
      throw new BadRequestException(
        `Google rejected the connection: ${reason}`,
      );
    }

    const identity = await fetchGoogleIdentity(body.access_token);
    const grantedScopes = (body.scope ?? '').split(' ').filter(Boolean);
    const expiresAt = new Date(Date.now() + (body.expires_in ?? 3600) * 1000);
    const displayName = identity.email ?? identity.name ?? null;

    const existing = await this.prisma.app_connections.findFirst({
      where: {
        account_id: args.state.accountId,
        provider: args.state.provider,
        externalAccountId: identity.sub,
      },
      select: { id: true, scopes: true },
    });

    if (existing) {
      // Reconnect of an account we already know. Scopes are UNIONED, not
      // replaced: with include_granted_scopes Google returns everything
      // the user has granted, but a narrower response (or a provider
      // that behaves differently) must not silently shrink what we
      // believe we can do — that turns a working automation into a
      // "missing scope" error with no user-visible cause.
      const merged = Array.from(
        new Set([...existing.scopes, ...grantedScopes]),
      );
      await this.prisma.app_connections.update({
        where: { id: existing.id },
        data: {
          displayName,
          scopes: merged,
          accessToken: encrypt(body.access_token),
          tokenExpiresAt: expiresAt,
          // Only when Google actually sent one — see the same guard in
          // ConnectionTokenService.refresh.
          ...(body.refresh_token
            ? { refreshToken: encrypt(body.refresh_token) }
            : {}),
          status: 'active',
          lastError: null,
          updatedAt: new Date(),
        },
      });
      return { connectionId: existing.id, displayName };
    }

    if (!body.refresh_token) {
      // A brand-new connection with no refresh token is unusable in an
      // hour, and would fail as "needs_reauth" long after the user
      // walked away believing they had connected. Refusing here is the
      // honest moment to say so.
      throw new BadRequestException(
        'Google did not return a refresh token. Remove this app at ' +
          'myaccount.google.com → Third-party access, then connect again.',
      );
    }

    const created = await this.prisma.app_connections.create({
      data: {
        account_id: args.state.accountId,
        provider: args.state.provider,
        externalAccountId: identity.sub,
        displayName,
        scopes: grantedScopes,
        accessToken: encrypt(body.access_token),
        refreshToken: encrypt(body.refresh_token),
        tokenExpiresAt: expiresAt,
        status: 'active',
        createdBy: args.state.userId,
      },
      select: { id: true },
    });

    return { connectionId: created.id, displayName };
  }
}
