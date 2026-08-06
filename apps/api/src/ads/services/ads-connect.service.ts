import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { encrypt } from '../../common/security/encryption.util';
import {
  ADS_SCOPES,
  adsAppCredentials,
  adsRedirectUri,
  adsSandbox,
} from '../ads.config';
import {
  debugToken,
  exchangeLongLivedToken,
  getAdAccount,
  getAdAccounts,
  getBusinesses,
  getMe,
  getPages,
  getPixels,
  stripActPrefix,
  type MetaAdAccount,
  type MetaBusiness,
  type MetaPage,
  type MetaPixel,
} from '../marketing-api.util';
import {
  SANDBOX_AD_ACCOUNTS,
  SANDBOX_BUSINESSES,
  SANDBOX_GRANTED_SCOPES,
  SANDBOX_PAGES,
  SANDBOX_PIXELS,
  SANDBOX_PROFILE,
  SANDBOX_PREFIX,
} from '../sandbox/fixtures';
import {
  decodeAdsOAuthState,
  encodeAdsOAuthState,
} from '../utils/ads-oauth-state.util';
import { AdsConfigService } from './ads-config.service';

/**
 * Connect / select-assets / disconnect for the Ads Manager.
 *
 * WHY A SERVER-SIDE REDIRECT AND NOT THE FACEBOOK JS SDK
 *   The existing Facebook lead-ads screen uses the browser SDK
 *   (`window.FB.login`) and receives an access token in page JavaScript.
 *   This flow deliberately does not, for two reasons:
 *
 *     1. An ads token can spend money. It should never exist in a
 *        browser, in a devtools network tab, or in anything an injected
 *        script could read.
 *     2. `connect.facebook.net` is not in the CSP `script-src`
 *        allowlist in apps/web/next.config.ts. The policy currently
 *        ships as Report-Only, so the SDK still loads — but the moment
 *        it is enforced, every SDK-based connect flow breaks. Building
 *        a new one on that foundation would be knowingly adding to the
 *        cleanup.
 *
 *   So: authorize URL → Meta → our callback → code exchange
 *   server-side. The browser only ever sees a redirect.
 *
 * THE STATE IS THE AUTHORISATION
 *   The callback is a top-level cross-site GET, so it cannot rely on a
 *   session cookie. The signed `state` carries the accountId that
 *   started the flow, which is what stops a captured callback URL from
 *   attaching an attacker's ad account to a victim's workspace. See
 *   common/security/oauth-state.util.ts.
 */
@Injectable()
export class AdsConnectService {
  private readonly logger = new Logger(AdsConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AdsConfigService,
  ) {}

  // ------------------------------------------------------------
  // Step 1 — the authorize URL
  // ------------------------------------------------------------

  /**
   * Build the URL to send the browser to.
   *
   * `auth_type=rerequest` is not optional: without it, a user who
   * declined `ads_management` the first time is shown no dialog at all
   * on a second attempt — Meta silently returns the same reduced grant,
   * and the connection looks like it succeeded while still being
   * unusable. That is precisely the failure `granted_scopes` exists to
   * detect, and this is how the user can actually fix it.
   */
  buildAuthorizeUrl(args: {
    accountId: string;
    userId: string;
    returnTo?: string;
  }): string {
    const { appId } = adsAppCredentials();
    const redirectUri = adsRedirectUri();

    if (!redirectUri) {
      throw new BadRequestException(
        'META_ADS_REDIRECT_URI is not configured on this server. It must exactly match a Valid OAuth Redirect URI in the Meta app dashboard.',
      );
    }

    const search = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state: encodeAdsOAuthState({
        accountId: args.accountId,
        userId: args.userId,
        returnTo: args.returnTo,
      }),
      scope: ADS_SCOPES.join(','),
      response_type: 'code',
      auth_type: 'rerequest',
    });

    return `https://www.facebook.com/v23.0/dialog/oauth?${search.toString()}`;
  }

  // ------------------------------------------------------------
  // Step 2 — the callback
  // ------------------------------------------------------------

  /**
   * Exchange the code, verify what was granted, and store the
   * connection in `pending_setup`.
   *
   * NOT `connected` — the token alone is useless until an ad account
   * and a page have been chosen, and a row that claims to be connected
   * while `ad_account_id IS NULL` would make every downstream
   * "connected?" check lie.
   */
  async handleCallback(args: { code: string; state: string }): Promise<{
    accountId: string;
    returnTo: string | null;
  }> {
    const payload = decodeAdsOAuthState(args.state);
    if (!payload) {
      // Expired, tampered, or minted for a different flow. There is no
      // safe default here — proceeding would mean guessing which
      // workspace to attach an ad account to.
      throw new BadRequestException(
        'This connection link has expired or is invalid. Start again from Ads Manager → Setup.',
      );
    }

    const { appId, appSecret } = adsAppCredentials();
    const redirectUri = adsRedirectUri();
    if (!redirectUri) {
      throw new BadRequestException(
        'META_ADS_REDIRECT_URI is not configured on this server.',
      );
    }

    // code → short-lived token. This endpoint authenticates with the
    // app secret in the query string, so it does not go through
    // graphRequest.
    const tokenSearch = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code: args.code,
    });

    const tokenResponse = await fetch(
      `https://graph.facebook.com/v23.0/oauth/access_token?${tokenSearch.toString()}`,
    );

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text();
      this.logger.error(`Ads OAuth code exchange failed: ${body}`);
      throw new BadRequestException(
        'Facebook rejected the sign-in. Check that the redirect URI in the Meta app dashboard matches this server exactly, then try again.',
      );
    }

    const shortLived = (await tokenResponse.json()) as {
      access_token?: string;
    };
    if (!shortLived.access_token) {
      throw new BadRequestException('Facebook returned no access token.');
    }

    // Short-lived (~1h) → long-lived (~60d). Skipping this leaves a
    // connection that dies within the hour.
    const longLived = await exchangeLongLivedToken({
      appId,
      appSecret,
      shortLivedToken: shortLived.access_token,
    });

    // What Meta ACTUALLY granted, which is not what we asked for — the
    // consent dialog lets individual permissions be declined.
    const tokenInfo = await debugToken({
      appId,
      appSecret,
      inputToken: longLived.accessToken,
    });

    const profile = await getMe({ accessToken: longLived.accessToken });

    const expiresAt =
      tokenInfo.expiresAt ??
      (longLived.expiresInSeconds
        ? new Date(Date.now() + longLived.expiresInSeconds * 1000)
        : null);

    await this.prisma.meta_ads_config.upsert({
      where: { account_id: payload.accountId },
      create: {
        account_id: payload.accountId,
        user_id: payload.userId,
        fb_user_id: profile.id,
        fb_user_name: profile.name,
        access_token: encrypt(longLived.accessToken),
        token_expires_at: expiresAt,
        granted_scopes: tokenInfo.scopes,
        status: 'pending_setup',
        connected_at: new Date(),
      },
      update: {
        // Reconnecting as a different Facebook user replaces the
        // identity but keeps the workspace's asset selections, which are
        // still valid as long as the new user can administer them. The
        // selections are re-validated on the next publish.
        user_id: payload.userId,
        fb_user_id: profile.id,
        fb_user_name: profile.name,
        access_token: encrypt(longLived.accessToken),
        token_expires_at: expiresAt,
        granted_scopes: tokenInfo.scopes,
        status: 'pending_setup',
        last_error: null,
        connected_at: new Date(),
        updated_at: new Date(),
      },
    });

    await this.config.audit({
      accountId: payload.accountId,
      userId: payload.userId,
      action: 'connect',
      objectType: 'fb_user',
      objectId: profile.id,
      detail: { granted_scopes: tokenInfo.scopes },
    });

    return { accountId: payload.accountId, returnTo: payload.returnTo ?? null };
  }

  /**
   * Sandbox connect — the no-Meta path.
   *
   * Reachable only when `ADS_MANAGER_SANDBOX=true`, so this cannot be
   * used to fake a connection in production.
   */
  async connectSandbox(args: {
    accountId: string;
    userId: string;
  }): Promise<void> {
    if (!adsSandbox()) {
      throw new NotFoundException();
    }

    await this.prisma.meta_ads_config.upsert({
      where: { account_id: args.accountId },
      create: {
        account_id: args.accountId,
        user_id: args.userId,
        fb_user_id: SANDBOX_PROFILE.id,
        fb_user_name: SANDBOX_PROFILE.name,
        access_token: encrypt(`${SANDBOX_PREFIX}user_token`),
        granted_scopes: SANDBOX_GRANTED_SCOPES,
        status: 'pending_setup',
        connected_at: new Date(),
      },
      update: {
        user_id: args.userId,
        fb_user_id: SANDBOX_PROFILE.id,
        fb_user_name: SANDBOX_PROFILE.name,
        access_token: encrypt(`${SANDBOX_PREFIX}user_token`),
        granted_scopes: SANDBOX_GRANTED_SCOPES,
        status: 'pending_setup',
        last_error: null,
        connected_at: new Date(),
        updated_at: new Date(),
      },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'connect_sandbox',
    });
  }

  // ------------------------------------------------------------
  // Step 3 — the pickers
  //
  // Each returns a list for the Setup screen to choose from. None of
  // them takes an id from the caller: the token comes from the stored
  // connection, so a user can only ever enumerate assets their own
  // workspace's Facebook user can administer.
  // ------------------------------------------------------------

  async listBusinesses(accountId: string): Promise<MetaBusiness[]> {
    if (adsSandbox()) return SANDBOX_BUSINESSES;
    const connection = await this.config.requireConnection(accountId);
    return getBusinesses({ accessToken: connection.accessToken });
  }

  /**
   * Ad accounts, optionally within one business.
   *
   * `businessId` IS accepted from the caller here, and that is safe in a
   * way the ad account id is not: it only narrows a list Meta already
   * scopes to the connected user's own permissions. A wrong or hostile
   * value yields an empty list or a Graph permission error, never
   * another tenant's data.
   */
  async listAdAccounts(
    accountId: string,
    businessId?: string,
  ): Promise<MetaAdAccount[]> {
    if (adsSandbox()) return SANDBOX_AD_ACCOUNTS;
    const connection = await this.config.requireConnection(accountId);
    return getAdAccounts({
      accessToken: connection.accessToken,
      businessId,
    });
  }

  async listPages(accountId: string): Promise<MetaPage[]> {
    if (adsSandbox()) return SANDBOX_PAGES;
    const connection = await this.config.requireConnection(accountId);
    return getPages({ accessToken: connection.accessToken });
  }

  async listPixels(accountId: string): Promise<MetaPixel[]> {
    if (adsSandbox()) return SANDBOX_PIXELS;
    const connection = await this.config.requireAdAccount(accountId);
    return getPixels({
      accessToken: connection.accessToken,
      adAccountId: connection.adAccountId,
    });
  }

  // ------------------------------------------------------------
  // Step 4 — the selections
  // ------------------------------------------------------------

  /**
   * Choose the ad account.
   *
   * The id is re-read from Meta rather than trusted from the request
   * body — not for tenant isolation (Meta would reject an account this
   * user cannot administer anyway) but because we need Meta's own
   * `currency`, `timezone_name`, `account_status` and funding state, and
   * asking is the only way to get them. Currency in particular is
   * load-bearing: every budget in this product is minor units OF THAT
   * CURRENCY, so guessing it wrong is a silent 100× error.
   */
  async selectAdAccount(args: {
    accountId: string;
    userId: string;
    adAccountId: string;
    businessId?: string;
  }): Promise<void> {
    const connection = await this.config.requireConnection(args.accountId);
    const bare = stripActPrefix(args.adAccountId);

    let resolved: MetaAdAccount | undefined;

    if (adsSandbox()) {
      resolved = SANDBOX_AD_ACCOUNTS.find((a) => a.id === bare);
      if (!resolved) throw new NotFoundException('Unknown sandbox ad account.');
    } else {
      resolved = await getAdAccount({
        accessToken: connection.accessToken,
        adAccountId: bare,
      });
    }

    const business = args.businessId
      ? (await this.listBusinesses(args.accountId)).find(
          (b) => b.id === args.businessId,
        )
      : undefined;

    await this.prisma.meta_ads_config.update({
      where: { account_id: args.accountId },
      data: {
        ad_account_id: resolved.id,
        ad_account_name: resolved.name,
        currency: resolved.currency,
        timezone_name: resolved.timezoneName,
        account_status: resolved.accountStatus,
        funding_ok: resolved.fundingOk,
        business_id: args.businessId ?? connection.businessId,
        business_name: business?.name ?? connection.businessName,
        updated_at: new Date(),
      },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'select_ad_account',
      objectType: 'ad_account',
      objectId: resolved.id,
      detail: {
        currency: resolved.currency,
        account_status: resolved.accountStatus,
        funding_ok: resolved.fundingOk,
      },
    });

    await this.markConnectedIfReady(args.accountId);

    // Pull history so the Overview has something to show before the first
    // nightly sync. Fire-and-forget: a queue that is down must not fail the
    // selection, which is the thing the user actually asked for.
    if (this.onAdAccountSelected) {
      void this.onAdAccountSelected(args.accountId).catch((err: unknown) => {
        this.logger.warn(
          `Could not queue the history backfill for account ${args.accountId}`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  /**
   * Hook the module wires to `AdsSyncProcessor.enqueueBackfill`.
   *
   * A callback rather than a constructor dependency to avoid a cycle: the
   * processor depends on AdsSyncService which depends on AdsConfigService,
   * and injecting the processor here would close the loop. Nest would need
   * a forwardRef for what is one optional call.
   */
  onAdAccountSelected?: (accountId: string) => Promise<void>;

  /**
   * Choose the page the ads run from.
   *
   * Refuses a page the user cannot advertise with. Meta returns pages
   * with a `tasks` list, and a page without `ADVERTISE` fails at ad
   * creation with a permissions error that names neither the page nor
   * the task — so it is worth catching here, where we can say which.
   */
  async selectPage(args: {
    accountId: string;
    userId: string;
    pageId: string;
  }): Promise<void> {
    const pages = await this.listPages(args.accountId);
    const page = pages.find((p) => p.id === args.pageId);

    if (!page) {
      throw new NotFoundException(
        'That page is not available on the connected Facebook account.',
      );
    }

    if (!page.tasks.includes('ADVERTISE')) {
      throw new BadRequestException(
        `You do not have permission to run ads for "${page.name}". Ask a page admin to grant you the Advertise task in Meta Business Settings, then reconnect.`,
      );
    }

    await this.prisma.meta_ads_config.update({
      where: { account_id: args.accountId },
      data: {
        page_id: page.id,
        page_name: page.name,
        page_access_token: page.accessToken ? encrypt(page.accessToken) : null,
        updated_at: new Date(),
      },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'select_page',
      objectType: 'page',
      objectId: page.id,
    });

    await this.markConnectedIfReady(args.accountId);
  }

  /**
   * Link the WhatsApp destination for Click-to-WhatsApp ads.
   *
   * Takes no number from the caller: it is resolved from this
   * workspace's own `whatsapp_config`. There is exactly one connected
   * WhatsApp number per account, so a picker would be a picker of one —
   * and accepting a number would mean accepting an arbitrary
   * `phone_number_id`, which is somebody else's WhatsApp account.
   */
  async linkWhatsApp(args: {
    accountId: string;
    userId: string;
  }): Promise<void> {
    const whatsapp = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: args.accountId },
      select: { phone_number_id: true, status: true },
    });

    if (!whatsapp) {
      throw new BadRequestException(
        'No WhatsApp number is connected to this workspace. Connect one in Channels → WhatsApp first — Click-to-WhatsApp ads need somewhere to deliver the conversation.',
      );
    }

    await this.prisma.meta_ads_config.update({
      where: { account_id: args.accountId },
      data: {
        whatsapp_phone_number_id: whatsapp.phone_number_id,
        updated_at: new Date(),
      },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'link_whatsapp',
      objectType: 'whatsapp_phone_number',
      objectId: whatsapp.phone_number_id,
    });
  }

  /** Choose the pixel used by conversion-optimised website ads. Nullable to clear. */
  async selectPixel(args: {
    accountId: string;
    userId: string;
    pixelId: string | null;
  }): Promise<void> {
    if (args.pixelId === null) {
      await this.prisma.meta_ads_config.update({
        where: { account_id: args.accountId },
        data: { pixel_id: null, pixel_name: null, updated_at: new Date() },
      });
      return;
    }

    const pixels = await this.listPixels(args.accountId);
    const pixel = pixels.find((p) => p.id === args.pixelId);
    if (!pixel) {
      throw new NotFoundException(
        'That pixel is not available on the connected ad account.',
      );
    }

    await this.prisma.meta_ads_config.update({
      where: { account_id: args.accountId },
      data: {
        pixel_id: pixel.id,
        pixel_name: pixel.name,
        updated_at: new Date(),
      },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'select_pixel',
      objectType: 'pixel',
      objectId: pixel.id,
    });
  }

  /**
   * Record that the page accepted Meta's Lead Ads terms.
   *
   * We only record it; accepting happens in Meta's own UI. Storing a
   * local timestamp is what lets the Setup checklist stop nagging, and
   * it is deliberately not treated as authoritative — lead-form creation
   * still surfaces Meta's error if the terms were never really accepted.
   */
  async acceptLeadTerms(args: {
    accountId: string;
    userId: string;
  }): Promise<void> {
    await this.config.requireConnection(args.accountId);

    await this.prisma.meta_ads_config.update({
      where: { account_id: args.accountId },
      data: { lead_terms_accepted_at: new Date(), updated_at: new Date() },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'accept_lead_terms',
    });
  }

  // ------------------------------------------------------------
  // Disconnect
  // ------------------------------------------------------------

  /**
   * Forget the connection.
   *
   * Deletes the config row (and with it both encrypted tokens) but
   * deliberately LEAVES the mirrored campaigns, ads and insights: they
   * are a record of money that was spent, and a disconnect should not
   * silently erase spend history. They are already orphaned from a
   * token, so nothing can act on them; reconnecting the same ad account
   * makes them live again.
   */
  async disconnect(args: { accountId: string; userId: string }): Promise<void> {
    const existing = await this.prisma.meta_ads_config.findUnique({
      where: { account_id: args.accountId },
      select: { id: true, ad_account_id: true },
    });

    if (!existing) return;

    await this.prisma.meta_ads_config.delete({
      where: { account_id: args.accountId },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'disconnect',
      objectType: 'ad_account',
      objectId: existing.ad_account_id,
    });
  }

  // ------------------------------------------------------------

  /**
   * Promote `pending_setup` → `connected` once the minimum viable
   * selection exists.
   *
   * "Minimum viable" is an ad account plus a page: with both, at least
   * one ad type can be published. The WhatsApp number and pixel are
   * per-ad-type requirements enforced by the builders, so waiting for
   * them here would leave a fully usable website-ad setup stuck looking
   * unfinished.
   */
  private async markConnectedIfReady(accountId: string): Promise<void> {
    const row = await this.prisma.meta_ads_config.findUnique({
      where: { account_id: accountId },
      select: { ad_account_id: true, page_id: true, status: true },
    });

    if (!row || row.status === 'connected') return;
    if (!row.ad_account_id || !row.page_id) return;

    await this.prisma.meta_ads_config.update({
      where: { account_id: accountId },
      data: { status: 'connected', updated_at: new Date() },
    });
  }
}
