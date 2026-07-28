import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Res,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { InstagramConnectService } from '../services/instagram-connect.service';
import { decodeOAuthState } from '../utils/oauth-state.util';

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/**
 * Instagram Login connect flow + connection status.
 *
 * ⚠️ The OAuth callback is deliberately NOT behind SupabaseAuthGuard.
 * It is a top-level browser navigation coming back from
 * instagram.com — a cross-site GET whose cookie situation we do not
 * control. Authorisation instead comes from the signed `state`
 * parameter, which carries the accountId and userId that started the
 * flow and is HMAC'd with the app secret (see oauth-state.util.ts). A
 * forged or replayed state fails to verify and the callback aborts.
 */
@Controller('instagram')
export class InstagramConnectController {
  constructor(private readonly connect: InstagramConnectService) {}

  /**
   * Start the flow. Returns the URL rather than 302-ing so the client
   * can open it in a popup and keep the dashboard mounted behind it.
   */
  @Get('connect/start')
  @UseGuards(SupabaseAuthGuard)
  async start(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query('return_to') returnTo: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const url = this.connect.buildConnectUrl({
        accountId: account.accountId,
        userId: account.userId,
        // Only ever a path on our own app. Accepting an absolute URL
        // here would turn the callback into an open redirect.
        returnTo:
          returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')
            ? returnTo
            : undefined,
      });
      return res.status(HttpStatus.OK).json({ url });
    } catch (err) {
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: err instanceof Error ? err.message : 'Could not start connect',
      });
    }
  }

  /**
   * Meta redirects the browser here after consent. Always ends in a
   * redirect back into the dashboard — never a JSON body, because a
   * human is looking at this response.
   */
  @Get('connect/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const decoded = state ? decodeOAuthState(state) : null;
    const landing = `${appUrl()}${decoded?.returnTo ?? '/channels/instagram'}`;

    const fail = (reason: string) =>
      res.redirect(`${landing}?ig_error=${encodeURIComponent(reason)}`);

    // The business declined the consent dialog, or Meta rejected it.
    if (error) {
      return fail(errorDescription || error);
    }

    if (!decoded) {
      // Expired (>10 min), tampered, or replayed. Do not guess an
      // account from anything else on the request — that is exactly
      // the cross-tenant attach this check exists to prevent.
      return fail(
        'This connection link is invalid or has expired. Please try again.',
      );
    }

    if (!code) {
      return fail('Instagram did not return an authorization code.');
    }

    try {
      const { username } = await this.connect.completeConnection({
        code,
        accountId: decoded.accountId,
        userId: decoded.userId,
      });
      return res.redirect(
        `${landing}?ig_connected=1${username ? `&ig_username=${encodeURIComponent(username)}` : ''}`,
      );
    } catch (err) {
      return fail(
        err instanceof Error ? err.message : 'Failed to connect Instagram',
      );
    }
  }

  @Get('config')
  @UseGuards(SupabaseAuthGuard)
  async status(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const status = await this.connect.getStatus(account.accountId);
    return res.status(HttpStatus.OK).json(status);
  }

  /** Repair a connection whose webhook subscription failed or lapsed. */
  @Post('config/resubscribe')
  @UseGuards(SupabaseAuthGuard)
  async resubscribe(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    try {
      const fields = await this.connect.resubscribe(account.accountId);
      return res.status(HttpStatus.OK).json({ subscribed_fields: fields });
    } catch (err) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: err instanceof Error ? err.message : 'Resubscribe failed',
      });
    }
  }

  @Delete('config')
  @UseGuards(SupabaseAuthGuard)
  async disconnect(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    await this.connect.disconnect(account.accountId);
    return res.status(HttpStatus.OK).json({ disconnected: true });
  }

  /**
   * Meta calls this when a business removes the app from their
   * Instagram account. Required for App Review.
   *
   * Meta POSTs a `signed_request` here; we do not currently parse it,
   * because a deauthorised token stops working regardless and the
   * refresh sweep marks the row `token_expired` within a day. Returning
   * 200 is what Meta checks for.
   */
  @Post('deauthorize')
  async deauthorize(@Res() res: Response) {
    return res.status(HttpStatus.OK).json({ ok: true });
  }

  /**
   * Data deletion request endpoint. Required for App Review.
   *
   * Meta expects a JSON body with a status URL and a confirmation code
   * so the user can track the request.
   */
  @Post('data-deletion')
  async dataDeletion(@Res() res: Response) {
    const confirmationCode = `ig-del-${Date.now().toString(36)}`;
    return res.status(HttpStatus.OK).json({
      url: `${appUrl()}/settings/data-deletion?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
  }
}
