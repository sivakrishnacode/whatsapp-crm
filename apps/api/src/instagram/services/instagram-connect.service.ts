import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt, decrypt } from '../../common/security/encryption.util';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getSelfProfile,
  subscribeToWebhooks,
  unsubscribeFromWebhooks,
  IG_WEBHOOK_FIELDS,
} from '../ig-api.util';
import { encodeOAuthState } from '../utils/oauth-state.util';

export interface InstagramConnectionStatus {
  connected: boolean;
  status: string;
  ig_user_id: string | null;
  ig_username: string | null;
  profile_picture_url: string | null;
  connected_at: string | null;
  token_expires_at: string | null;
  /** Days until the 60-day token dies. Negative once expired. */
  token_expires_in_days: number | null;
  subscribed_fields: string[];
  last_error: string | null;
  /** True when the app has Human Agent approval (24h → 7d replies). */
  human_agent_enabled: boolean;
  /**
   * The two URLs an operator must register in the Meta dashboard,
   * echoed back so the settings page can show them verbatim.
   *
   * Worth the extra fields: both are easy to get subtly wrong (they
   * differ only in their path), and both fail with errors that name
   * neither the expected value nor where it goes — "Invalid
   * redirect_uri" on one, a generic "couldn't be validated" on the
   * other. Showing what the server will actually send turns a
   * dead-end into a copy-paste.
   */
  setup: {
    redirect_uri: string | null;
    webhook_url: string | null;
    app_id: string | null;
  };
}

/**
 * Instagram Login connect / disconnect for one CRM account.
 *
 * The flow, and why it is four API calls rather than one:
 *   1. authorize   — the browser gets consent from the business
 *   2. code→token  — a 1-hour short-lived token
 *   3. token→token — traded for a 60-day long-lived one
 *   4. subscribe   — tell Meta to push webhooks for this IG account
 *
 * Step 4 is the one that is easy to forget and impossible to notice:
 * without it the connection looks perfectly healthy and simply never
 * receives a message.
 */
@Injectable()
export class InstagramConnectService {
  private readonly logger = new Logger(InstagramConnectService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------
  // Config plumbing
  // ------------------------------------------------------------

  /**
   * Fail loudly and specifically at the start of a connect attempt.
   * Meta's errors for a wrong app id are unhelpful, and the three vars
   * are easy to half-configure.
   */
  private requireAppConfig(): {
    appId: string;
    appSecret: string;
    redirectUri: string;
  } {
    const appId = process.env.INSTAGRAM_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    const missing = [
      !appId && 'INSTAGRAM_APP_ID',
      !appSecret && 'INSTAGRAM_APP_SECRET',
      !redirectUri && 'INSTAGRAM_REDIRECT_URI',
    ].filter(Boolean);

    if (missing.length) {
      throw new Error(
        `Instagram is not configured on this server. Missing: ${missing.join(', ')}. ` +
          'These come from Meta → your app → Instagram → API setup with Instagram login, ' +
          'and are DIFFERENT values from META_APP_ID / META_APP_SECRET.',
      );
    }

    return { appId: appId!, appSecret: appSecret!, redirectUri: redirectUri! };
  }

  static humanAgentEnabled(): boolean {
    return process.env.INSTAGRAM_HUMAN_AGENT_ENABLED === 'true';
  }

  /**
   * The values an operator has to paste into the Meta dashboard.
   *
   * The webhook URL is derived from the redirect URI rather than
   * configured separately: both live on the API's public origin, and a
   * second env var is a second thing to get out of sync.
   */
  private setupInfo(): InstagramConnectionStatus['setup'] {
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI ?? null;
    let webhookUrl: string | null = null;
    if (redirectUri) {
      try {
        webhookUrl = new URL('/instagram/webhook', redirectUri).toString();
      } catch {
        // A malformed redirect URI is itself the problem; the UI shows
        // it as-is so the operator can see what is wrong.
      }
    }
    return {
      redirect_uri: redirectUri,
      webhook_url: webhookUrl,
      app_id: process.env.INSTAGRAM_APP_ID ?? null,
    };
  }

  // ------------------------------------------------------------
  // Step 1 — consent
  // ------------------------------------------------------------

  buildConnectUrl(args: {
    accountId: string;
    userId: string;
    returnTo?: string;
  }): string {
    const { appId, redirectUri } = this.requireAppConfig();
    return buildAuthorizeUrl({
      appId,
      redirectUri,
      state: encodeOAuthState({
        accountId: args.accountId,
        userId: args.userId,
        returnTo: args.returnTo,
      }),
    });
  }

  // ------------------------------------------------------------
  // Steps 2-4 — token exchange, profile, webhook subscription
  // ------------------------------------------------------------

  async completeConnection(args: {
    code: string;
    accountId: string;
    userId: string;
  }): Promise<{ igUserId: string; username?: string }> {
    const { appId, appSecret, redirectUri } = this.requireAppConfig();

    const shortLived = await exchangeCodeForToken({
      code: args.code,
      appId,
      appSecret,
      redirectUri,
    });

    const longLived = await exchangeForLongLivedToken({
      shortLivedToken: shortLived.accessToken,
      appSecret,
    });

    const accessToken = longLived.accessToken;
    const tokenExpiresAt = new Date(Date.now() + longLived.expiresIn * 1000);

    // Ask /me for the account's real identity rather than trusting the
    // OAuth response.
    //
    // The token exchange returns the **app-scoped** id, which the Graph
    // API will not accept as an object id: subscribing webhooks with it
    // fails with "Object with ID … does not exist, cannot be loaded due
    // to missing permissions, or does not support this operation" —
    // an error that points at permissions and never mentions that the
    // id itself is the wrong one.
    //
    // This call is therefore REQUIRED, not best-effort. Its failure
    // aborts the connection: persisting a config whose ig_user_id
    // cannot address the API produces an account that looks connected
    // and can neither send nor receive.
    let profile;
    try {
      profile = await getSelfProfile({ igUserId: 'me', accessToken });
    } catch (err) {
      throw new Error(
        'Connected to Instagram but could not read the account profile, so the ' +
          'professional account ID is unknown and the connection would not work. ' +
          `Please try again. (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    const igUserId = profile.igUserId;
    const username = profile.username;
    const profilePictureUrl = profile.profilePictureUrl;
    // Prefer /me's `id`, falling back to the OAuth response — both are
    // the app-scoped form, and either can appear as a webhook entry id.
    const appScopedId = profile.igAppScopedId ?? shortLived.appScopedUserId;

    // One Instagram account cannot serve two CRM accounts: the webhook
    // routes purely on entry[].id, so a second claim would make inbound
    // messages ambiguous. Refuse rather than silently steal the
    // connection from the other tenant.
    const existingElsewhere = await this.prisma.instagram_config.findFirst({
      where: { ig_user_id: igUserId, account_id: { not: args.accountId } },
      select: { id: true },
    });
    if (existingElsewhere) {
      throw new Error(
        'This Instagram account is already connected to a different workspace. ' +
          'Disconnect it there first.',
      );
    }

    // Subscribe BEFORE marking the row connected, so a subscription
    // failure surfaces as an error status the UI can act on instead of
    // a healthy-looking connection that never receives anything.
    let subscribedFields: string[] = [];
    let subscriptionError: string | null = null;
    try {
      await subscribeToWebhooks({ igUserId, accessToken });
      subscribedFields = [...IG_WEBHOOK_FIELDS];
    } catch (err) {
      subscriptionError =
        err instanceof Error ? err.message : 'Webhook subscription failed';
      this.logger.error(
        `Webhook subscription failed for ${igUserId}: ${subscriptionError}`,
      );
    }

    const now = new Date();
    const data = {
      user_id: args.userId,
      ig_user_id: igUserId,
      ig_app_scoped_id: appScopedId ?? null,
      ig_username: username ?? null,
      profile_picture_url: profilePictureUrl ?? null,
      access_token: encrypt(accessToken),
      token_expires_at: tokenExpiresAt,
      token_refreshed_at: now,
      status: subscriptionError ? 'error' : 'connected',
      subscribed_fields: subscribedFields,
      subscribed_at: subscriptionError ? null : now,
      connected_at: now,
      last_error: subscriptionError,
    };

    await this.prisma.instagram_config.upsert({
      where: { account_id: args.accountId },
      create: { account_id: args.accountId, ...data },
      update: data,
    });

    this.logger.log(
      `Instagram connected for account ${args.accountId} (ig_user_id=${igUserId}` +
        (username ? `, @${username}` : '') +
        `)${subscriptionError ? ' — WITH SUBSCRIPTION ERROR' : ''}`,
    );

    return { igUserId, username };
  }

  // ------------------------------------------------------------
  // Status
  // ------------------------------------------------------------

  async getStatus(accountId: string): Promise<InstagramConnectionStatus> {
    const config = await this.prisma.instagram_config.findUnique({
      where: { account_id: accountId },
    });

    if (!config) {
      return {
        connected: false,
        status: 'disconnected',
        ig_user_id: null,
        ig_username: null,
        profile_picture_url: null,
        connected_at: null,
        token_expires_at: null,
        token_expires_in_days: null,
        subscribed_fields: [],
        last_error: null,
        human_agent_enabled: InstagramConnectService.humanAgentEnabled(),
        setup: this.setupInfo(),
      };
    }

    const expiresInDays = config.token_expires_at
      ? Math.floor(
          (config.token_expires_at.getTime() - Date.now()) / 86_400_000,
        )
      : null;

    // Report an expired token as such even if the refresh sweep has not
    // run yet — the UI's remedy (reconnect) is the same either way, and
    // showing "connected" for a dead token is a support ticket.
    const status =
      expiresInDays !== null && expiresInDays < 0
        ? 'token_expired'
        : config.status;

    return {
      connected: status === 'connected',
      status,
      ig_user_id: config.ig_user_id,
      ig_username: config.ig_username,
      profile_picture_url: config.profile_picture_url,
      connected_at: config.connected_at?.toISOString() ?? null,
      token_expires_at: config.token_expires_at?.toISOString() ?? null,
      token_expires_in_days: expiresInDays,
      subscribed_fields: config.subscribed_fields,
      last_error: config.last_error,
      human_agent_enabled: InstagramConnectService.humanAgentEnabled(),
      setup: this.setupInfo(),
    };
  }

  // ------------------------------------------------------------
  // Disconnect
  // ------------------------------------------------------------

  /**
   * Unsubscribe at Meta, then drop the row.
   *
   * Conversation history is deliberately kept: it belongs to the
   * business, not to the connection, and reconnecting the same
   * Instagram account should pick the threads back up (IGSIDs are
   * stable for a given app).
   */
  async disconnect(accountId: string): Promise<void> {
    const config = await this.prisma.instagram_config.findUnique({
      where: { account_id: accountId },
    });
    if (!config) return;

    try {
      await unsubscribeFromWebhooks({
        igUserId: config.ig_user_id,
        accessToken: decrypt(config.access_token),
      });
    } catch (err) {
      // A dead token cannot unsubscribe, and that must not block the
      // user from clearing a broken connection. Meta stops delivering
      // once the token is revoked anyway.
      this.logger.warn(
        `Unsubscribe failed while disconnecting ${config.ig_user_id}; removing local config anyway: ${String(err)}`,
      );
    }

    await this.prisma.instagram_config.delete({
      where: { account_id: accountId },
    });

    this.logger.log(`Instagram disconnected for account ${accountId}`);
  }

  /**
   * Delete every connection belonging to one Instagram user.
   *
   * Called by Meta's deauthorize and data-deletion callbacks, where we
   * have an Instagram user id and no session — so this is keyed by the
   * Meta-side identifier rather than by account, and the caller must
   * have verified the `signed_request` signature before getting here.
   *
   * Matches on `ig_user_id` OR `ig_app_scoped_id` for the same reason
   * the webhook router does: one Instagram account reports two
   * different ids depending on which endpoint you ask, and which one
   * arrives in a callback is not documented. Matching only one would
   * silently honour a deletion request by doing nothing.
   *
   * Usually one row. A person can administer several workspaces, and
   * all of them lose the connection — the grant they revoked is what
   * every one of those connections was standing on.
   *
   * @returns how many connections were removed
   */
  async deleteForInstagramUser(igUserId: string): Promise<number> {
    const configs = await this.prisma.instagram_config.findMany({
      where: {
        OR: [{ ig_user_id: igUserId }, { ig_app_scoped_id: igUserId }],
      },
    });

    for (const config of configs) {
      try {
        await unsubscribeFromWebhooks({
          igUserId: config.ig_user_id,
          accessToken: decrypt(config.access_token),
        });
      } catch {
        // Expected on this path: the user has just revoked the grant,
        // so the token is already dead and cannot unsubscribe. Meta
        // stops delivering regardless. Never let it block the delete —
        // failing to honour a deletion request because a cleanup call
        // failed is the worst possible trade.
      }

      await this.prisma.instagram_config
        .delete({ where: { id: config.id } })
        .catch((err: unknown) => {
          // Logged, not thrown: Meta retries the callback, but failing
          // the whole request because one of several workspaces could
          // not be cleaned would leave the others unprocessed too.
          this.logger.error(
            `Data deletion: could not remove instagram_config ${config.id}`,
            err,
          );
        });
    }

    if (configs.length > 0) {
      this.logger.log(
        `Instagram data deletion for ${igUserId}: removed ${configs.length} connection(s)`,
      );
    }

    return configs.length;
  }

  // ------------------------------------------------------------
  // Shared loader for the send / webhook paths
  // ------------------------------------------------------------

  /**
   * The account's connection with a decrypted token, or null.
   *
   * Every outbound path goes through this so token decryption lives in
   * one place and a `token_expired` row can never be used to attempt a
   * doomed send.
   */
  async loadUsableConfig(accountId: string): Promise<{
    igUserId: string;
    accessToken: string;
    userId: string;
  } | null> {
    const config = await this.prisma.instagram_config.findUnique({
      where: { account_id: accountId },
    });
    if (!config) return null;
    if (config.status === 'token_expired') return null;
    if (config.token_expires_at && config.token_expires_at < new Date()) {
      return null;
    }

    try {
      return {
        igUserId: config.ig_user_id,
        accessToken: decrypt(config.access_token),
        userId: config.user_id,
      };
    } catch (err) {
      this.logger.error(
        `Could not decrypt the Instagram token for account ${accountId} — is ENCRYPTION_KEY correct for this environment?`,
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  /** Re-subscribe an existing connection — the settings page's repair button. */
  async resubscribe(accountId: string): Promise<string[]> {
    const usable = await this.loadUsableConfig(accountId);
    if (!usable) {
      throw new Error('Instagram is not connected, or its token has expired.');
    }

    await subscribeToWebhooks({
      igUserId: usable.igUserId,
      accessToken: usable.accessToken,
    });

    const fields = [...IG_WEBHOOK_FIELDS];
    await this.prisma.instagram_config.update({
      where: { account_id: accountId },
      data: {
        subscribed_fields: fields,
        subscribed_at: new Date(),
        status: 'connected',
        last_error: null,
      },
    });
    return fields;
  }
}
