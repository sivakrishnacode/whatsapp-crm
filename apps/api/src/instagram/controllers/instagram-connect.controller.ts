import {
  Body,
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Res,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { parseSignedRequest } from '../../common/security/signed-request.util';
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
   * Treated as a deletion of the connection, not merely a notification:
   * revoking the grant makes our stored token useless, and holding a
   * dead credential is strictly worse than holding none.
   *
   * This used to return a bare 200 without reading the body, on the
   * reasoning that a revoked token stops working anyway and the refresh
   * sweep would mark the row `token_expired` within a day. That reasoning
   * was wrong twice over: a deletion signal is about the data we hold,
   * not about whether the credential still functions, and "expired" is
   * not "deleted" — the encrypted token stayed in the table.
   */
  @Post('deauthorize')
  async deauthorize(
    @Body() body: { signed_request?: string } | undefined,
    @Res() res: Response,
  ) {
    const igUserId = this.verifySignedRequest(body?.signed_request).user_id;

    if (igUserId) {
      await this.connect.deleteForInstagramUser(igUserId);
    }

    return res.status(HttpStatus.OK).json({ ok: true });
  }

  /**
   * Data deletion request endpoint. Required for App Review.
   *
   * Meta expects JSON carrying a status URL a human can visit and a
   * confirmation code. Any other shape is rejected, and a rejected
   * response fails review.
   */
  @Post('data-deletion')
  async dataDeletion(
    @Body() body: { signed_request?: string } | undefined,
    @Res() res: Response,
  ) {
    const igUserId = this.verifySignedRequest(body?.signed_request).user_id;

    if (!igUserId) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'The request carried no user id.' });
    }

    await this.connect.deleteForInstagramUser(igUserId);

    // Derived from the user id rather than random so the status page can
    // answer without a lookup table. Not a secret: it only identifies
    // which request is being asked about, and Meta shows it to the user.
    const confirmationCode = `ig-${igUserId}`;

    return res.status(HttpStatus.OK).json({
      // A PUBLIC page. The previous value pointed at `/settings/...`,
      // which lives inside the dashboard's auth gate — Meta's reviewer,
      // and any real user who had just revoked access, would have hit a
      // login wall on a product they have left.
      url: `${appUrl()}/instagram-data-deletion?code=${encodeURIComponent(confirmationCode)}`,
      confirmation_code: confirmationCode,
    });
  }

  /**
   * Verify Meta's `signed_request`, or reject.
   *
   * ⚠️ This signature is the ONLY authorisation these two endpoints have
   * — no session, no bearer token, no guard. An unverified request would
   * let anyone delete any workspace's Instagram connection by guessing an
   * id, so a failure to verify must mean "reject", never "proceed".
   *
   * ⚠️ Signed with `INSTAGRAM_APP_SECRET`, not `META_APP_SECRET`. Meta
   * signs everything on the Instagram Login surface with the Instagram
   * app secret (the second credential pair inside the same Meta app), and
   * using the wrong one rejects 100% of callbacks with no other symptom.
   * Same trap as the webhook signature — see ig-webhook-signature.util.ts.
   */
  private verifySignedRequest(signedRequest: string | undefined): {
    user_id?: string;
  } {
    // `body` is optional at the call sites, not just the field: a POST with
    // no body and no Content-Type leaves it undefined, and reaching into it
    // would turn a malformed request into a 500. These are public
    // endpoints, so unparsed input has to land as a 400.
    if (!signedRequest) {
      throw new HttpException(
        'Missing signed_request.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    if (!appSecret) {
      // Fails closed. Accepting unverified deletion requests because the
      // server is misconfigured would be worse than returning an error
      // Meta will retry.
      throw new HttpException(
        'INSTAGRAM_APP_SECRET is not configured on this server.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const payload = parseSignedRequest(signedRequest, appSecret);
    if (!payload) {
      // 400 rather than 403: Meta's own docs treat a malformed request
      // this way, and it retries either way.
      throw new HttpException(
        'Invalid signed_request.',
        HttpStatus.BAD_REQUEST,
      );
    }

    return payload;
  }
}
