import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { adsAppCredentials } from '../ads.config';
import { parseSignedRequest } from '../utils/signed-request.util';

/**
 * Meta's data-deletion and deauthorize callbacks.
 *
 * Meta requires these for any app that stores user data, and checks the
 * URLs during App Review. Both are configured in
 * App → Settings → Basic.
 *
 * ⚠️ NO AUTH GUARD, AND NO FEATURE FLAG EITHER.
 *   No guard, because Meta's servers call these with no session — the
 *   `signed_request` HMAC is the authorisation, and a request that fails
 *   to verify is rejected outright.
 *
 *   No `AdsEnabledGuard`, unlike every other ads controller, and that is
 *   deliberate: a deletion request must succeed even if the feature has
 *   since been switched off. Gating it would mean that turning the flag
 *   off silently stops honouring deletion requests for data we are still
 *   holding, which is the opposite of what the flag is for.
 *
 * WHAT GETS DELETED
 *   The `meta_ads_config` row for the matching Facebook user, which takes
 *   both encrypted tokens with it. NOT the mirrored campaigns and
 *   insights: those are the business's own advertising records — spend
 *   that happened — and contain no personal data about the Facebook user
 *   who authorised the connection. Deleting a company's spend history
 *   because an employee revoked their personal Facebook grant would be
 *   destroying the wrong thing.
 *
 *   Audiences we pushed to Meta are Meta-side data; Meta removes those
 *   itself under the same request.
 */
@Controller('ads/privacy')
export class AdsPrivacyController {
  private readonly logger = new Logger(AdsPrivacyController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /api/ads/privacy/data-deletion
   *
   * Meta sends `signed_request` as a form field. The response must be JSON
   * with a `url` a human can visit to check status, and a
   * `confirmation_code` — Meta rejects any other shape, and a rejected
   * response fails App Review.
   */
  @Post('data-deletion')
  async dataDeletion(
    @Body() body?: { signed_request?: string },
  ): Promise<{ url: string; confirmation_code: string }> {
    const payload = this.verify(body?.signed_request);

    const fbUserId = payload.user_id;
    if (!fbUserId) {
      throw new BadRequestException('The request carried no user id.');
    }

    // Every workspace this Facebook user connected. Usually one, but a
    // person can administer several — all of them lose the connection.
    const rows = await this.prisma.meta_ads_config.findMany({
      where: { fb_user_id: fbUserId },
      select: { id: true, account_id: true },
    });

    for (const row of rows) {
      // The audit entry is written BEFORE the delete, because the delete
      // removes the row it refers to. `meta_ads_audit` is keyed by
      // account, not by config, so it survives.
      await this.prisma.meta_ads_audit
        .create({
          data: {
            account_id: row.account_id,
            action: 'data_deletion_request',
            object_type: 'fb_user',
            object_id: fbUserId,
            detail: { source: 'meta_callback' },
          },
        })
        .catch(() => undefined);

      await this.prisma.meta_ads_config
        .delete({ where: { id: row.id } })
        .catch((err: unknown) => {
          // Logged rather than thrown: Meta retries a failed callback, but
          // failing the whole request because one of several workspaces
          // could not be cleaned would leave the others unprocessed too.
          this.logger.error(
            `Data deletion: could not remove meta_ads_config ${row.id}`,
            err,
          );
        });
    }

    this.logger.log(
      `Data deletion for fb_user ${fbUserId}: removed ${rows.length} ad connection(s)`,
    );

    // The code is derived from the user id rather than random, so the
    // status endpoint below can answer without a lookup table. It is not a
    // secret: it only confirms which request is being asked about, and
    // Meta displays it to the user.
    const confirmationCode = `ads-${fbUserId}`;

    return {
      // A PUBLIC page, deliberately not under `/ads/*`. Those routes live
      // in the dashboard group behind an auth gate and the feature flag —
      // a status URL Meta shows to someone who has just revoked access
      // must not require them to log in to a product they have left.
      url: `${appUrl()}/ads-data-deletion?code=${encodeURIComponent(confirmationCode)}`,
      confirmation_code: confirmationCode,
    };
  }

  /**
   * POST /api/ads/privacy/deauthorize
   *
   * Fired when someone removes the app from their Facebook settings. Meta
   * expects a 200 and ignores the body.
   *
   * Treated as a deletion of the connection, not of the data: revoking the
   * grant makes our stored token useless, so keeping it serves no purpose
   * and holding a dead credential is strictly worse than holding none.
   */
  @Post('deauthorize')
  async deauthorize(
    @Body() body?: { signed_request?: string },
  ): Promise<{ ok: true }> {
    const payload = this.verify(body?.signed_request);
    const fbUserId = payload.user_id;

    if (fbUserId) {
      const { count } = await this.prisma.meta_ads_config.deleteMany({
        where: { fb_user_id: fbUserId },
      });
      this.logger.log(
        `Deauthorize for fb_user ${fbUserId}: removed ${count} ad connection(s)`,
      );
    }

    return { ok: true };
  }

  /**
   * GET /api/ads/privacy/data-deletion-status?code=
   *
   * The human-readable page Meta links to. Deliberately says nothing about
   * whether that code ever existed: confirming or denying would turn this
   * into an oracle for "did this Facebook user use this product", which is
   * exactly the kind of thing a deletion endpoint should not leak.
   */
  @Get('data-deletion-status')
  status(@Query('code') code?: string): {
    status: string;
    confirmation_code: string | null;
  } {
    return {
      status:
        'Any Meta ad-account connection associated with this request has been deleted, along with its stored access tokens.',
      confirmation_code: code ?? null,
    };
  }

  /**
   * Verify or reject. Never returns a partial result.
   */
  private verify(signedRequest: string | undefined): {
    user_id?: string;
  } {
    // `body` itself is optional at the call sites, not just the field: a POST
    // with no body and no Content-Type leaves it undefined, and reaching into
    // it turned a malformed request into a 500 rather than a 400. These are
    // public endpoints, so unparsed input has to land here as a 400.
    if (!signedRequest) {
      throw new BadRequestException('Missing signed_request.');
    }

    const { appSecret } = adsAppCredentials();
    const payload = parseSignedRequest(signedRequest, appSecret);

    if (!payload) {
      this.logger.warn(
        'Rejected a privacy callback with an invalid signed_request.',
      );
      // 400 rather than 403: Meta's own docs treat a malformed request this
      // way, and it retries either way.
      throw new BadRequestException('Invalid signed_request.');
    }

    return payload;
  }
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}
