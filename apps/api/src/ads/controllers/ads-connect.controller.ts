import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { AdsEnabledGuard } from '../guards/ads-enabled.guard';
import { adsSandbox } from '../ads.config';
import {
  AdsConfigService,
  type AdsSetupStatus,
} from '../services/ads-config.service';
import { AdsConnectService } from '../services/ads-connect.service';
import {
  ListAdAccountsQueryDto,
  SelectAdAccountDto,
  SelectPageDto,
  SelectPixelDto,
  StartOAuthQueryDto,
} from '../dto/ads-connect.dto';

/** Where the callback sends the browser back to, per `returnTo`. */
const RETURN_PATHS: Record<'setup' | 'create', string> = {
  setup: '/ads/setup',
  create: '/ads/create',
};

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/**
 * `/ads/*` — the Ads Manager's connect and setup surface.
 *
 * Internal dashboard endpoints (Supabase cookie auth), gated on the
 * `ADS_MANAGER_ENABLED` flag.
 *
 * ROLES
 *   Reads are open to any member so the whole workspace can see whether
 *   ads are running. Every write is `admin`+, matching the RLS in
 *   migration 068: choosing an ad account is choosing whose card gets
 *   charged, and publishing spends from it.
 *
 * NO ENDPOINT HERE ACCEPTS AN AD ACCOUNT ID AS AUTHORITY.
 *   The ids in the DTOs are selections from lists this API produced, and
 *   the services re-resolve each one against the stored connection or
 *   against Meta. Prisma bypasses RLS, so nothing else is protecting
 *   these queries.
 */
@Controller('ads')
@UseGuards(AdsEnabledGuard, SupabaseAuthGuard)
export class AdsConnectController {
  constructor(
    private readonly config: AdsConfigService,
    private readonly connect: AdsConnectService,
  ) {}

  /**
   * GET /api/ads/status — everything the Setup screen renders.
   *
   * Includes the derived checklist and `canPublish`, so the wizard's
   * Publish button and the API's publish guard cannot disagree.
   */
  @Get('status')
  async status(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<AdsSetupStatus> {
    return this.config.getStatus(account.accountId);
  }

  /**
   * GET /api/ads/oauth/start — the URL to send the browser to.
   *
   * Returns the URL rather than 302-ing so the client can open it in a
   * popup and keep the dashboard mounted behind it, matching the
   * Instagram connect flow.
   */
  @Get('oauth/start')
  @RequireRole('admin')
  start(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query() query: StartOAuthQueryDto,
  ): { url: string } {
    return {
      url: this.connect.buildAuthorizeUrl({
        accountId: account.accountId,
        userId: account.userId,
        returnTo: query.returnTo,
      }),
    };
  }

  /**
   * POST /api/ads/oauth/sandbox — connect without Meta.
   *
   * 404s unless `ADS_MANAGER_SANDBOX=true`, so it cannot be used to fake
   * a connection in production.
   */
  @Post('oauth/sandbox')
  @RequireRole('admin')
  async sandbox(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<AdsSetupStatus> {
    await this.connect.connectSandbox({
      accountId: account.accountId,
      userId: account.userId,
    });
    return this.config.getStatus(account.accountId);
  }

  // ------------------------------------------------------------
  // Pickers
  // ------------------------------------------------------------

  @Get('businesses')
  async businesses(@CurrentAccount() account: SupabaseAccountContext) {
    return { data: await this.connect.listBusinesses(account.accountId) };
  }

  @Get('ad-accounts')
  async adAccounts(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query() query: ListAdAccountsQueryDto,
  ) {
    return {
      data: await this.connect.listAdAccounts(
        account.accountId,
        query.businessId,
      ),
    };
  }

  /**
   * GET /api/ads/pages
   *
   * Page access tokens are stripped from the response. They are
   * credentials — the browser has no use for one, and a page token in a
   * JSON body is a page token in a devtools tab and a HAR file.
   */
  @Get('pages')
  async pages(@CurrentAccount() account: SupabaseAccountContext) {
    const pages = await this.connect.listPages(account.accountId);
    // Built field-by-field rather than by spreading and omitting: an
    // explicit shape means a page token can never be added back into this
    // response by a later change to `MetaPage`.
    return {
      data: pages.map((page) => ({
        id: page.id,
        name: page.name,
        tasks: page.tasks,
        instagramActorId: page.instagramActorId,
        /** Surfaced so the UI can disable pages the user cannot advertise with. */
        canAdvertise: page.tasks.includes('ADVERTISE'),
      })),
    };
  }

  @Get('pixels')
  async pixels(@CurrentAccount() account: SupabaseAccountContext) {
    return { data: await this.connect.listPixels(account.accountId) };
  }

  // ------------------------------------------------------------
  // Selections — all admin+
  // ------------------------------------------------------------

  @Post('ad-account')
  @RequireRole('admin')
  async selectAdAccount(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: SelectAdAccountDto,
  ): Promise<AdsSetupStatus> {
    await this.connect.selectAdAccount({
      accountId: account.accountId,
      userId: account.userId,
      adAccountId: dto.adAccountId,
      businessId: dto.businessId,
    });
    return this.config.getStatus(account.accountId);
  }

  @Post('page')
  @RequireRole('admin')
  async selectPage(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: SelectPageDto,
  ): Promise<AdsSetupStatus> {
    await this.connect.selectPage({
      accountId: account.accountId,
      userId: account.userId,
      pageId: dto.pageId,
    });
    return this.config.getStatus(account.accountId);
  }

  /**
   * POST /api/ads/whatsapp — link the Click-to-WhatsApp destination.
   *
   * Takes no body: the number is resolved from this workspace's own
   * `whatsapp_config`. Accepting a `phone_number_id` would be accepting
   * someone else's WhatsApp account.
   */
  @Post('whatsapp')
  @RequireRole('admin')
  async linkWhatsApp(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<AdsSetupStatus> {
    await this.connect.linkWhatsApp({
      accountId: account.accountId,
      userId: account.userId,
    });
    return this.config.getStatus(account.accountId);
  }

  @Post('pixel')
  @RequireRole('admin')
  async selectPixel(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: SelectPixelDto,
  ): Promise<AdsSetupStatus> {
    await this.connect.selectPixel({
      accountId: account.accountId,
      userId: account.userId,
      pixelId: dto.pixelId ?? null,
    });
    return this.config.getStatus(account.accountId);
  }

  @Post('lead-terms')
  @RequireRole('admin')
  async acceptLeadTerms(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<AdsSetupStatus> {
    await this.connect.acceptLeadTerms({
      accountId: account.accountId,
      userId: account.userId,
    });
    return this.config.getStatus(account.accountId);
  }

  /**
   * GET /api/ads/audit — who did what, including failed attempts.
   *
   * `admin`+, matching the RLS on `meta_ads_audit`: it records spending
   * decisions, so it is not general workspace reading.
   */
  @Get('audit')
  @RequireRole('admin')
  async audit(@CurrentAccount() account: SupabaseAccountContext) {
    return { data: await this.config.listAudit(account.accountId) };
  }

  /**
   * DELETE /api/ads/connection
   *
   * Drops the tokens but keeps the mirrored campaigns and insights —
   * they record money that was spent. See `AdsConnectService.disconnect`.
   */
  @Delete('connection')
  @RequireRole('admin')
  async disconnect(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<AdsSetupStatus> {
    await this.connect.disconnect({
      accountId: account.accountId,
      userId: account.userId,
    });
    return this.config.getStatus(account.accountId);
  }
}

/**
 * The OAuth callback — its own controller so it gets NO auth guard.
 *
 * ⚠️ Deliberately outside `SupabaseAuthGuard`, exactly like
 * `InstagramConnectController.callback` and
 * `FacebookLeadsWebhookController`. This is a top-level browser
 * navigation returning from facebook.com: a cross-site GET whose cookie
 * situation we do not control. Authorisation comes from the signed
 * `state`, which carries the accountId and userId that started the flow
 * and is HMAC'd with the app secret. A forged, replayed or expired state
 * fails to verify and the callback aborts without writing anything.
 *
 * Still behind `AdsEnabledGuard` — a disabled feature should have no
 * reachable callback.
 */
@Controller('ads/oauth')
@UseGuards(AdsEnabledGuard)
export class AdsOAuthController {
  constructor(private readonly connect: AdsConnectService) {}

  /**
   * GET /api/ads/oauth/callback
   *
   * Always ends in a redirect into the dashboard, never a JSON body — a
   * human is looking at this response.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Query('error_reason') errorReason: string | undefined,
    @Res() res: Response,
  ) {
    // The landing page is a fixed allowlist entry, not anything from the
    // query string: this value round-trips through facebook.com, so a
    // free-form redirect target here would be an open redirect.
    const landing = `${appUrl()}${RETURN_PATHS.setup}`;

    const fail = (reason: string) =>
      res.redirect(`${landing}?ads_error=${encodeURIComponent(reason)}`);

    if (error) {
      // The user pressed Cancel, or Meta rejected the request.
      return fail(errorDescription || errorReason || error);
    }

    if (!state) return fail('Missing state. Please start again.');
    if (!code) {
      return fail('Facebook did not return an authorization code.');
    }

    try {
      const { returnTo } = await this.connect.handleCallback({ code, state });
      const target =
        returnTo && returnTo in RETURN_PATHS
          ? `${appUrl()}${RETURN_PATHS[returnTo as 'setup' | 'create']}`
          : landing;
      return res.redirect(`${target}?ads_connected=1`);
    } catch (err) {
      return fail(
        err instanceof Error
          ? err.message
          : 'Failed to connect your Meta ad account.',
      );
    }
  }

  /**
   * GET /api/ads/oauth/config — what an operator must paste into Meta.
   *
   * The redirect URI is the single most common setup mistake and Meta's
   * error for a mismatch ("Invalid redirect_uri") names neither the
   * expected value nor where it goes. Echoing what this server will
   * actually send turns a dead end into a copy-paste. Same reasoning as
   * `InstagramConnectionStatus.setup`.
   *
   * No auth guard is needed because it returns only configuration this
   * server's operator already knows — the app id is public by design and
   * the redirect URI is visible in any authorize URL.
   */
  @Get('config')
  config(): {
    redirect_uri: string | null;
    sandbox: boolean;
  } {
    return {
      redirect_uri: process.env.META_ADS_REDIRECT_URI ?? null,
      sandbox: adsSandbox(),
    };
  }
}
