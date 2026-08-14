import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt, encrypt } from '../../common/security/encryption.util';
import {
  GOOGLE_TOKEN_URL,
  googleOAuthConfig,
} from '../connectors/google/google.oauth';

/**
 * ⚠️ THE ONLY PLACE AN APP-CONNECTION TOKEN IS DECRYPTED.
 *
 * Everything else asks this service for a live access token. Same rule
 * as AdsConfigService for ads tokens and the AI module for provider
 * keys: one auditable decryption point, so "who can read a refresh
 * token" is answerable by reading one file.
 *
 * WHAT MUST NEVER HAPPEN HERE
 *   A token must not reach a queue payload (Redis stores job data in
 *   plaintext and Bull Board renders it), an API response, or a log
 *   line. Processors re-read and decrypt — which also means a
 *   re-consented token takes effect on the next job rather than needing
 *   a redeploy.
 *
 * REFRESH IS SERIALISED PER CONNECTION
 *   Ten automation runs can hit one connection in the same second. Ten
 *   parallel refreshes against Google's token endpoint is at best
 *   wasteful and at worst self-defeating: some Google flows invalidate
 *   older refresh tokens when a new one is issued, so a race can leave
 *   the row holding a token Google has already retired. `inFlight`
 *   collapses concurrent refreshes for one connection into one call.
 *
 *   This is per-process, not distributed. Two API instances can still
 *   refresh simultaneously, which is survivable (Google returns a valid
 *   token to both) and is the same trade the rest of the codebase makes.
 */

/**
 * Refresh this far before the token actually expires.
 *
 * 120s, not 0: a token that passes the check and then expires during a
 * multi-round action produces a 401 halfway through — after a calendar
 * event was created but before the Meet link was read back.
 */
const EXPIRY_SKEW_MS = 120_000;

export class ConnectionReauthRequired extends Error {
  constructor(
    readonly connectionId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionReauthRequired';
  }
}

@Injectable()
export class ConnectionTokenService {
  private readonly logger = new Logger(ConnectionTokenService.name);
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A usable access token for this connection, refreshing if needed.
   *
   * ⚠️ Callers MUST pass the accountId they are acting for. The
   * connection id arrives from an automation's step config, which is
   * author-supplied data, and Prisma bypasses RLS — the account filter
   * in the query below is the entire tenant boundary for this table.
   */
  async getAccessToken(args: {
    connectionId: string;
    accountId: string;
  }): Promise<string> {
    const row = await this.prisma.app_connections.findFirst({
      where: { id: args.connectionId, account_id: args.accountId },
    });

    if (!row) {
      throw new ConnectionReauthRequired(
        args.connectionId,
        'That connection no longer exists in this workspace.',
      );
    }
    if (row.status !== 'active') {
      throw new ConnectionReauthRequired(
        row.id,
        `The ${row.provider} connection for ${row.displayName ?? 'this workspace'} needs to be reconnected.`,
      );
    }

    const expiresAt = row.tokenExpiresAt?.getTime() ?? 0;
    if (expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return this.decryptOrReauth(row.accessToken, row.id);
    }

    const existing = this.inFlight.get(row.id);
    if (existing) return existing;

    const refresh = this.refresh(
      row.id,
      row.provider,
      row.refreshToken,
    ).finally(() => this.inFlight.delete(row.id));
    this.inFlight.set(row.id, refresh);
    return refresh;
  }

  /**
   * Exchange the refresh token for a new access token and store it.
   *
   * A dead grant is recorded as `needs_reauth` rather than retried: an
   * `invalid_grant` does not heal, and a run that keeps retrying it just
   * turns one visible failure into a queue full of invisible ones.
   */
  private async refresh(
    connectionId: string,
    provider: string,
    encryptedRefreshToken: string | null,
  ): Promise<string> {
    if (!encryptedRefreshToken) {
      await this.markNeedsReauth(
        connectionId,
        'No refresh token is stored for this connection.',
      );
      throw new ConnectionReauthRequired(
        connectionId,
        'This connection has no refresh token and must be reconnected.',
      );
    }

    if (provider !== 'google') {
      throw new ConnectionReauthRequired(
        connectionId,
        `Unknown provider "${provider}" — cannot refresh.`,
      );
    }

    const refreshToken = this.decryptOrReauth(
      encryptedRefreshToken,
      connectionId,
    );
    const { clientId, clientSecret } = googleOAuthConfig();

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      redirect: 'manual',
    });

    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!res.ok || !body.access_token) {
      const reason =
        body.error_description ?? body.error ?? `HTTP ${res.status}`;

      // `invalid_grant` is the terminal one: the user revoked access at
      // myaccount.google.com, changed their password, or the app is
      // still in Testing (where Google expires refresh tokens after 7
      // days). Anything else may be transient, so it does not burn the
      // connection — the run fails and the next one retries.
      if (body.error === 'invalid_grant') {
        await this.markNeedsReauth(connectionId, reason);
        throw new ConnectionReauthRequired(
          connectionId,
          `Google has revoked this connection (${reason}). Reconnect it from Integrations.`,
        );
      }

      this.logger.error(
        `Token refresh failed for connection ${connectionId}: ${reason}`,
      );
      throw new Error(`Could not refresh the Google connection: ${reason}`);
    }

    const expiresAt = new Date(Date.now() + (body.expires_in ?? 3600) * 1000);

    await this.prisma.app_connections.update({
      where: { id: connectionId },
      data: {
        accessToken: encrypt(body.access_token),
        tokenExpiresAt: expiresAt,
        // ⚠️ Only overwrite the refresh token when Google actually sent
        // a new one. A refresh response usually omits it, and writing
        // null here would silently destroy the connection at the next
        // expiry — the failure would surface days later, far from here.
        ...(body.refresh_token
          ? { refreshToken: encrypt(body.refresh_token) }
          : {}),
        status: 'active',
        lastError: null,
        updatedAt: new Date(),
      },
    });

    return body.access_token;
  }

  private decryptOrReauth(ciphertext: string, connectionId: string): string {
    try {
      return decrypt(ciphertext);
    } catch {
      // This is what a rotated ENCRYPTION_KEY looks like. The row is
      // unusable and no amount of retrying fixes it, so say so plainly.
      throw new ConnectionReauthRequired(
        connectionId,
        'This connection could not be decrypted and must be reconnected.',
      );
    }
  }

  private async markNeedsReauth(
    connectionId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.app_connections
      .update({
        where: { id: connectionId },
        data: { status: 'needs_reauth', lastError: reason.slice(0, 500) },
      })
      .catch(() => undefined); // best effort: the throw is the real signal
  }
}
