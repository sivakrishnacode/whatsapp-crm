import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';

import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import {
  BRIDGE_MANIFEST,
  renderBridgeSource,
} from '../bridge-source';
import {
  BRIDGE_VERSION,
  GOOGLE_SCRIPT_ACTIONS,
  GOOGLE_SERVICE_LABELS,
} from '../google-script.catalog';
import { GoogleScriptConnectionService } from '../services/google-script-connection.service';
import { GoogleScriptExecutorService } from '../services/google-script-executor.service';

/**
 * The Google integration's dashboard surface.
 *
 * ONE INTEGRATION, NOT FOUR. Gmail, Calendar, Meet and Sheets all arrive
 * through a single deployment, so there is a single connected/not state
 * and a single card in the UI. The old connector needed four because
 * incremental consent made "connected" a per-scope question; nothing here
 * is granted incrementally.
 *
 * ⚠️ There is no OAuth callback route, and that absence is the point of
 * the whole redesign: nothing in this module talks to Google, so nothing
 * needs Google's verification review.
 */
@Controller('google-script')
@UseGuards(SupabaseAuthGuard)
export class GoogleScriptController {
  constructor(
    private readonly connections: GoogleScriptConnectionService,
    private readonly executor: GoogleScriptExecutorService,
  ) {}

  /** Redacted status for the Integrations page. Never the secret or URL. */
  @Get()
  async status(@CurrentAccount() account: SupabaseAccountContext) {
    return { connection: await this.connections.summary(account.accountId) };
  }

  /**
   * The action catalogue the automation editor renders from, plus the
   * manifest the setup guide shows.
   *
   * Served rather than duplicated in the web bundle so there is exactly
   * one authority for what a field is called and whether it is required —
   * the same reason the segment rule vocabulary lives in SQL.
   */
  @Get('catalog')
  catalog() {
    return {
      version: BRIDGE_VERSION,
      actions: GOOGLE_SCRIPT_ACTIONS,
      serviceLabels: GOOGLE_SERVICE_LABELS,
      manifest: BRIDGE_MANIFEST,
    };
  }

  /**
   * Mint a secret and return the ready-to-paste script.
   *
   * ⚠️ THE ONLY RESPONSE IN THE PRODUCT THAT CONTAINS THE SECRET, and it
   * is unrepeatable: the stored copy is encrypted and nothing decrypts it
   * for a browser. Calling this again mints a NEW secret and invalidates
   * whatever script is deployed — which is correct (a customer re-pasting
   * a script should get a fresh one) but means the UI must warn before
   * re-running it on a working connection.
   *
   * Admin-and-above: the response can send mail as the workspace's Google
   * account, so it is not something a member should be able to fetch.
   */
  @Post('provision')
  @RequireRole('admin')
  async provision(@CurrentAccount() account: SupabaseAccountContext) {
    const { secret } = await this.connections.provision(account.accountId, account.userId);
    return {
      script: renderBridgeSource(secret),
      manifest: BRIDGE_MANIFEST,
      version: BRIDGE_VERSION,
    };
  }

  /** Store the /exec URL once they have deployed. Validated server-side. */
  @Post('url')
  @RequireRole('admin')
  async saveUrl(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { exec_url?: string },
  ) {
    await this.connections.saveExecUrl(account.accountId, body.exec_url ?? '');
    return { connection: await this.connections.summary(account.accountId) };
  }

  /**
   * Prove the bridge works, end to end, from our server.
   *
   * Uses `check_availability` deliberately: it is the only action that
   * changes nothing. A test that sent an email or created an event would
   * make "press Test" a thing customers avoid.
   */
  @Post('test')
  @RequireRole('admin')
  async test(@CurrentAccount() account: SupabaseAccountContext) {
    const now = new Date();
    const until = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    try {
      const result = await this.executor.run(account.accountId, 'check_availability', {
        from: now.toISOString(),
        to: until.toISOString(),
      });
      const busy = Array.isArray(result.output.busy) ? result.output.busy.length : 0;
      return {
        ok: true,
        detail: `Connected. Your calendar has ${busy} busy block(s) in the next 24 hours.`,
        connection: await this.connections.summary(account.accountId),
      };
    } catch (err) {
      return {
        ok: false,
        // The executor's messages are written for this screen: they name
        // the setting to change rather than quoting Google at the user.
        detail: err instanceof Error ? err.message : String(err),
        connection: await this.connections.summary(account.accountId),
      };
    }
  }

  /**
   * Forget the bridge.
   *
   * ⚠️ This does NOT undeploy anything. The script keeps running in the
   * customer's account and its URL keeps working for anyone who still has
   * the URL and the secret — we simply stop being one of them. The UI has
   * to say so, or "Disconnect" reads as a revocation it is not: the honest
   * revocation is deleting the deployment in Apps Script.
   */
  @Delete()
  @RequireRole('admin')
  async disconnect(@CurrentAccount() account: SupabaseAccountContext) {
    await this.connections.remove(account.accountId);
    return { connection: await this.connections.summary(account.accountId) };
  }
}
