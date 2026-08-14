import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type * as express from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { ConnectionService } from '../services/connection.service';
import { ConnectorRegistryService } from '../services/connector-registry.service';
import { ConnectorExecutionService } from '../services/connector-execution.service';
import { OAuthFlowService } from '../services/oauth-flow.service';
import { GOOGLE_IDENTITY_SCOPES } from '../connectors/google/google.oauth';

/**
 * The dashboard-facing half of app connections.
 *
 * The OAuth CALLBACK is deliberately not here — it cannot carry a
 * session cookie, so it lives in its own unguarded controller.
 */
@Controller('connections')
@UseGuards(SupabaseAuthGuard)
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly registry: ConnectorRegistryService,
    private readonly execution: ConnectorExecutionService,
    private readonly oauth: OAuthFlowService,
  ) {}

  /**
   * Connected accounts for this workspace.
   *
   * ⚠️ Returns ConnectionSummary — no token fields, ever. See
   * ConnectionService.toSummary.
   */
  @Get()
  async list(@CurrentAccount() account: SupabaseAccountContext) {
    return { connections: await this.connections.list(account.accountId) };
  }

  /**
   * The app + action catalogue the automation editor renders from.
   *
   * Served rather than duplicated in the web bundle so there is exactly
   * one authority for what a field is called and whether it is required
   * — the same reason `contact_matches_segment_rule()` is the authority
   * for segment rules.
   */
  @Get('catalog')
  catalog() {
    return { apps: this.registry.catalog() };
  }

  /**
   * Start a connect flow: 302 into the provider's consent screen.
   *
   * `app` narrows the scopes to that app's needs, which is what makes
   * incremental consent work — somebody adding a Sheets step is not
   * asked for permission to send email. Omitted, it asks for identity
   * only, which is a valid "just link the account" flow.
   */
  @Get(':provider/oauth/start')
  start(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('provider') provider: string,
    @Query('app') app: string | undefined,
    @Query('returnTo') returnTo: string | undefined,
    @Res() res: express.Response,
  ) {
    const scopes = app
      ? this.registry.scopesForApp(app)
      : [...GOOGLE_IDENTITY_SCOPES];

    const url = this.oauth.buildAuthorizeUrl({
      provider,
      accountId: account.accountId,
      userId: account.userId,
      requestedScopes: scopes,
      returnTo,
    });

    return res.redirect(url);
  }

  /**
   * Options for a `resource_select` field — sheet tabs, calendars.
   *
   * POST rather than GET because it takes the values of the fields the
   * dropdown depends on (a tab list needs a spreadsheet id), and those
   * are user data that has no business in a URL or an access log.
   */
  @Post(':id/resources/:app/:resource')
  async resources(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Param('app') app: string,
    @Param('resource') resource: string,
    @Body() body: { input?: Record<string, unknown> },
  ) {
    const options = await this.execution.resource({
      accountId: account.accountId,
      connectionId: id,
      app,
      resource,
      input: body?.input ?? {},
    });
    return { options };
  }

  /**
   * Run one action now, from the editor's Test tab.
   *
   * ⚠️ There is no dry-run. Google has no preview mode for a send or an
   * invite, so this really sends. The `irreversible` flag on an action
   * is what the editor uses to confirm before calling this; the API
   * requires the caller to acknowledge it too, so a scripted call cannot
   * skip the warning the UI shows.
   */
  @Post(':id/test')
  async test(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body()
    body: {
      app?: string;
      action?: string;
      input?: Record<string, unknown>;
      confirmed?: boolean;
    },
  ) {
    if (!body?.app || !body?.action) {
      throw new BadRequestException('app and action are required.');
    }

    const action = this.registry.requireAction(body.app, body.action);
    if (action.irreversible && !body.confirmed) {
      throw new BadRequestException(
        `"${action.label}" cannot be tested without sending for real. ` +
          'Confirm to continue.',
      );
    }

    const result = await this.execution.run({
      accountId: account.accountId,
      connectionId: id,
      app: body.app,
      actionId: body.action,
      input: body.input ?? {},
    });

    return { ok: true, output: result.output, detail: result.detail };
  }

  @Delete(':id')
  async disconnect(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ) {
    await this.connections.disconnect({
      connectionId: id,
      accountId: account.accountId,
    });
    return { ok: true };
  }
}
