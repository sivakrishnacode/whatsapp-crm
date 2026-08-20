import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Logger,
  Res,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomInt } from 'node:crypto';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectAccountService } from '../services/connect-account.service';
import {
  exchangeEmbeddedSignupCode,
  verifyPhoneNumber,
  getSubscribedApps,
  getPhoneNumberHealth,
  isPhoneRegistered,
  MetaApiError,
  MetaTokenExpiredError,
} from '../meta-api.util';
import {
  decrypt,
  encrypt,
  isLegacyFormat,
} from '../../common/security/encryption.util';

@Controller('whatsapp')
@UseGuards(SupabaseAuthGuard)
export class WhatsappConnectController {
  private readonly logger = new Logger(WhatsappConnectController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectAccount: ConnectAccountService,
  ) {}

  /**
   * POST /api/whatsapp/connect
   *
   * Completes the Embedded Signup flow. Receives OAuth code + WABA/phone ids
   * from the client, exchanges the code for a long-lived token, then calls
   * saveWhatsAppConnection (shared with the manual-config route).
   */
  @Post('connect')
  async embeddedSignup(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const { code, waba_id, phone_number_id, business_id, coexistence } = body;

    if (!code || !waba_id || !phone_number_id) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'code, waba_id and phone_number_id are required',
      });
    }

    const appId =
      process.env.META_APP_ID || process.env.NEXT_PUBLIC_FACEBOOK_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: 'Meta App credentials are not configured on the server.',
      });
    }

    let accessToken: string;
    let tokenExpiresAt: string | null = null;

    try {
      const exchanged = await exchangeEmbeddedSignupCode({
        code,
        appId,
        appSecret,
      });
      accessToken = exchanged.accessToken;
      if (exchanged.expiresIn) {
        tokenExpiresAt = new Date(
          Date.now() + exchanged.expiresIn * 1000,
        ).toISOString();
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown error exchanging code';
      return res.status(HttpStatus.BAD_REQUEST).json({ error: message });
    }

    const isCoexistence = Boolean(coexistence);
    // Generate a random 6-digit PIN for first-time registrations.
    // Coexistence numbers are already registered by the WhatsApp Business App.
    const generatedPin = String(randomInt(100000, 1000000));

    const result = await this.connectAccount.saveWhatsAppConnection({
      accountId: account.accountId,
      userId: account.userId,
      phoneNumberId: phone_number_id,
      wabaId: waba_id,
      accessToken,
      pin: isCoexistence ? null : generatedPin,
      skipRegistration: isCoexistence,
      businessId: business_id || null,
      connectionMethod: 'embedded_signup',
      tokenExpiresAt,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    return res.status(HttpStatus.OK).json({
      success: true,
      saved: true,
      registered: result.registered,
      registration_error: result.registration_error,
      registration_skipped: result.registration_skipped,
      phone_info: result.phone_info,
    });
  }

  /**
   * GET /api/whatsapp/config
   *
   * Health-check endpoint: decrypts stored token and validates with Meta.
   * Returns 200 in all non-auth cases so the UI can render a specific message.
   */
  @Get('config')
  async getConfig(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: account.accountId },
      select: {
        phone_number_id: true,
        access_token: true,
        status: true,
        token_expires_at: true,
        catalog_id: true,
        registered_at: true,
      },
    });

    if (!config) {
      return res.status(HttpStatus.OK).json({
        connected: false,
        reason: 'no_config',
        message:
          'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
      });
    }

    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token);
    } catch {
      return res.status(HttpStatus.OK).json({
        connected: false,
        reason: 'token_corrupted',
        needs_reset: true,
        message:
          'The stored access token cannot be decrypted with the current ENCRYPTION_KEY.',
      });
    }

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const tokenExpiresAt = config.token_expires_at?.toISOString() ?? null;
    const tokenExpiringSoon = Boolean(
      tokenExpiresAt &&
      new Date(tokenExpiresAt).getTime() - Date.now() < SEVEN_DAYS_MS,
    );

    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      });

      // Health is advisory: it answers "why can't this number send?",
      // and a number that cannot send is still connected. A failure here
      // must never downgrade the connection.
      let health: Awaited<ReturnType<typeof getPhoneNumberHealth>> | null =
        null;
      try {
        health = await getPhoneNumberHealth({
          phoneNumberId: config.phone_number_id,
          accessToken,
        });
      } catch (err) {
        this.logger.warn(
          `health_status unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return res.status(HttpStatus.OK).json({
        connected: true,
        phone_info: phoneInfo,
        token_expires_at: tokenExpiresAt,
        token_expiring_soon: tokenExpiringSoon,
        catalog_id: config.catalog_id ?? null,
        // Meta's own answer, not our bookkeeping. `registered_at` is what
        // we last managed to write; this is whether the number is live.
        registration: {
          registered: isPhoneRegistered(phoneInfo),
          status: phoneInfo.status ?? null,
          is_pin_enabled: phoneInfo.is_pin_enabled ?? null,
        },
        health: health
          ? {
              can_send_message: health.canSendMessage,
              blockers: health.blockers,
              notes: health.notes,
            }
          : null,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';

      // Only an authentication failure means the stored credentials are
      // no longer good. Anything else — a throttle, a 500, a network
      // blip, Meta being briefly inconsistent about a number registered
      // seconds ago — is us failing to reach Meta, not the account being
      // disconnected. Reporting those as `connected: false` is what made
      // a fresh Embedded Signup take two page refreshes to show up.
      const isAuthFailure =
        err instanceof MetaTokenExpiredError ||
        (err instanceof MetaApiError && err.code === 190);

      if (isAuthFailure) {
        return res.status(HttpStatus.OK).json({
          connected: false,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
        });
      }

      this.logger.warn(`WhatsApp config check degraded: ${message}`);
      return res.status(HttpStatus.OK).json({
        connected: true,
        degraded: true,
        reason: 'meta_unreachable',
        message: `Could not reach Meta to refresh the connection: ${message}`,
        token_expires_at: tokenExpiresAt,
        token_expiring_soon: tokenExpiringSoon,
        catalog_id: config.catalog_id ?? null,
        registration: {
          registered: config.registered_at != null,
          status: null,
          is_pin_enabled: null,
        },
        health: null,
      });
    }
  }

  /**
   * POST /api/whatsapp/config
   *
   * Manual entry: saves or updates the WhatsApp config for the authenticated user.
   */
  @Post('config')
  async saveConfig(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const {
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
      pin,
      catalog_id,
    } = body;

    if (!access_token || !phone_number_id) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'access_token and phone_number_id are required',
      });
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return res
          .status(HttpStatus.BAD_REQUEST)
          .json({ error: 'PIN must be exactly 6 digits.' });
      }
    }

    const result = await this.connectAccount.saveWhatsAppConnection({
      accountId: account.accountId,
      userId: account.userId,
      phoneNumberId: phone_number_id,
      wabaId: waba_id || null,
      accessToken: access_token,
      verifyToken: verify_token || null,
      pin: pin || null,
      connectionMethod: 'manual',
      catalogId:
        catalog_id === undefined ? undefined : String(catalog_id).trim(),
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    if (result.registration_error) {
      return res.status(HttpStatus.OK).json({
        success: false,
        saved: true,
        registered: false,
        registration_error: result.registration_error,
        phone_info: result.phone_info,
      });
    }

    return res.status(HttpStatus.OK).json({
      success: true,
      saved: true,
      registered: result.registered,
      registration_skipped: result.registration_skipped,
      phone_info: result.phone_info,
    });
  }

  /**
   * PATCH /api/whatsapp/config/catalog
   *
   * Sets (or clears) the Meta Commerce catalog id used for product /
   * product-list messages. Kept separate from POST /config so a merchant —
   * especially an Embedded Signup one with no manual form — can set the
   * catalog id without re-entering their access token.
   */
  @Patch('config/catalog')
  async setCatalogId(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { catalog_id?: string | null },
    @Res() res: Response,
  ) {
    const raw = body?.catalog_id;
    const catalogId = raw == null ? '' : String(raw).trim();
    if (catalogId && !/^\d+$/.test(catalogId)) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Catalog ID must be the numeric id from Meta Commerce Manager.',
      });
    }

    const { count } = await this.prisma.whatsapp_config.updateMany({
      where: { account_id: account.accountId },
      data: { catalog_id: catalogId || null, updated_at: new Date() },
    });
    if (count === 0) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Connect your WhatsApp account before setting a catalog id.',
      });
    }

    return res
      .status(HttpStatus.OK)
      .json({ success: true, catalog_id: catalogId || null });
  }

  /**
   * DELETE /api/whatsapp/config
   *
   * Removes the WhatsApp configuration row (used by "Reset Configuration" button).
   */
  @Delete('config')
  async deleteConfig(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    await this.prisma.whatsapp_config.deleteMany({
      where: { account_id: account.accountId },
    });

    return res.status(HttpStatus.OK).json({ success: true });
  }

  /**
   * GET /api/whatsapp/config/verify-registration
   *
   * Diagnostic endpoint: runs three independent checks (phone metadata,
   * WABA subscription, local registered_at timestamp).
   */
  @Get('config/verify-registration')
  async verifyRegistration(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const config = await this.prisma.whatsapp_config.findUnique({
      where: { account_id: account.accountId },
    });

    if (!config) {
      return res.status(HttpStatus.OK).json({
        live: false,
        checks: { config_exists: false },
        message: 'No WhatsApp configuration saved yet.',
      });
    }

    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token);
    } catch {
      return res.status(HttpStatus.OK).json({
        live: false,
        checks: { config_exists: true, token_decryptable: false },
        message:
          "Stored access token can't be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.",
      });
    }

    // Upgrade CBC → GCM if needed
    if (isLegacyFormat(config.access_token)) {
      try {
        await this.prisma.whatsapp_config.update({
          where: { id: config.id },
          data: { access_token: encrypt(accessToken) },
        });
      } catch {
        // non-fatal
      }
    }

    const checks: {
      config_exists: boolean;
      token_decryptable: boolean;
      phone_metadata_ok: boolean;
      waba_subscribed_to_app: boolean | null;
      registered_at_meta: boolean | null;
      locally_marked_registered: boolean;
    } = {
      config_exists: true,
      token_decryptable: true,
      phone_metadata_ok: false,
      waba_subscribed_to_app: null,
      registered_at_meta: null,
      locally_marked_registered: config.registered_at != null,
    };
    const errors: string[] = [];

    // 1. Phone metadata — and, from the same call, whether Meta itself
    //    considers the number registered. That is the authority; the
    //    local column is only a record of what we last managed to do.
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      });
      checks.phone_metadata_ok = true;
      checks.registered_at_meta = isPhoneRegistered(phoneInfo);
      if (!checks.registered_at_meta) {
        errors.push(
          `Meta reports this number as "${phoneInfo.status ?? 'unknown'}" rather than CONNECTED — it is not registered for Cloud API.`,
        );
      }
    } catch (err) {
      errors.push(
        `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. WABA subscription
    if (config.waba_id) {
      try {
        const subs = await getSubscribedApps({
          wabaId: config.waba_id,
          accessToken,
        });
        checks.waba_subscribed_to_app = subs.length > 0;
        if (!checks.waba_subscribed_to_app) {
          errors.push(
            'WABA has no subscribed apps. Re-save the configuration to subscribe.',
          );
        }
      } catch (err) {
        errors.push(
          `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      errors.push(
        "No WABA ID on file — webhooks can't be wired without it. Add it in the form and re-save.",
      );
    }

    // Live = Meta can reach us and we can reach Meta. Deliberately NOT
    // gated on `locally_marked_registered`: that column is bookkeeping,
    // and a number Meta reports as CONNECTED is receiving events whatever
    // our row happens to say.
    const live =
      checks.phone_metadata_ok &&
      (checks.waba_subscribed_to_app ?? false) &&
      (checks.registered_at_meta ?? false);

    // Self-heal the row while we have the answer, so the banner that sent
    // the user here stops lying on the next load.
    if (live && config.registered_at == null) {
      try {
        await this.prisma.whatsapp_config.update({
          where: { id: config.id },
          data: {
            registered_at: new Date(),
            status: 'connected',
            connected_at: config.connected_at ?? new Date(),
            last_registration_error: null,
          },
        });
      } catch (err) {
        this.logger.warn(
          `Could not repair registration state: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return res.status(HttpStatus.OK).json({
      live,
      checks,
      errors,
      last_registration_error: config.last_registration_error ?? null,
      registered_at: config.registered_at ?? null,
      subscribed_apps_at: config.subscribed_apps_at ?? null,
    });
  }
}
