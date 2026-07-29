import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import {
  WebConfigService,
  type WebConnectionStatus,
} from '../services/web-config.service';
import { UpdateWebConfigDto } from '../dto/update-web-config.dto';

/**
 * Web widget settings for the dashboard.
 *
 * Counterpart to `instagram/config`, and reached from the browser as
 * `/api/web/config` via the rewrite in apps/web/next.config.ts.
 *
 * Everything visitor-facing lives on a separate controller under
 * `public/web/*` with its own guards — keeping the two apart means a
 * mistake in a public route cannot inherit dashboard authentication, and
 * a reader can tell which surface a handler belongs to from its file.
 *
 * `GET` is member-readable because the rail's status dot and the inbox
 * composer both need to know whether Web is live. Every mutation is
 * admin-only, matching the RLS policies in migration 053.
 */
@Controller('web/config')
@UseGuards(SupabaseAuthGuard)
export class WebConfigController {
  constructor(private readonly config: WebConfigService) {}

  /**
   * The account's widget config, created on first read.
   *
   * Creating on a GET is deliberate and safe: a fresh row has an empty
   * `allowed_origins`, and an empty allowlist denies every request — so
   * nothing is reachable until an admin adds an origin. It saves an
   * "enable this channel" step that would have no other purpose.
   */
  @Get()
  async get(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<WebConnectionStatus> {
    return this.config.getOrCreate(account.accountId, account.userId);
  }

  @Patch()
  @RequireRole('admin')
  async update(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: UpdateWebConfigDto,
  ): Promise<WebConnectionStatus> {
    return this.config.update(account.accountId, account.userId, {
      allowed_origins: body.allowed_origins,
      appearance: body.appearance,
      business_hours: body.business_hours as never,
      ai_enabled: body.ai_enabled,
      show_branding: body.show_branding,
      locale: body.locale,
      status: body.status,
      prechat_form_id: body.prechat_form_id,
      offline_form_id: body.offline_form_id,
    });
  }

  /**
   * Mint a new widget key. Breaks every installed snippet until the
   * customer pastes the new one, which is the point — it is the remedy
   * for a key being used somewhere it should not be.
   *
   * Its own route rather than a field on PATCH so a stray property in a
   * settings payload can never trigger it.
   */
  @Post('rotate-key')
  @RequireRole('admin')
  async rotateKey(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<WebConnectionStatus> {
    await this.config.getOrCreate(account.accountId, account.userId);
    return this.config.rotateKey(account.accountId);
  }

  /**
   * Mint a new signing secret. Drops every live visitor session but
   * leaves installed snippets working — a smaller blast radius than
   * rotating the key, hence a separate route.
   */
  @Post('rotate-secret')
  @RequireRole('admin')
  async rotateSecret(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<WebConnectionStatus> {
    await this.config.getOrCreate(account.accountId, account.userId);
    return this.config.rotateSecret(account.accountId);
  }

  /**
   * Turn the widget off without losing appearance, allowlist or history.
   *
   * A hard delete would orphan the config context of every existing
   * `web` conversation, so DELETE is a soft disable — recoverable by
   * PATCHing status back to `connected`.
   */
  @Delete()
  @RequireRole('admin')
  async disconnect(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<{ success: true }> {
    await this.config.disconnect(account.accountId);
    return { success: true };
  }
}
