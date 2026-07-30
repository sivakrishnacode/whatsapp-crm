import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { RequireRole } from '../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../auth/types/account-context.type';
import { FormsService } from './services/forms.service';
import type { FormJson } from './services/forms.service';
import type { FormField, FormNotify, FormSettings } from './form.types';
import type { Availability } from './slot-engine.util';

interface CreateFormDto {
  name: string;
  description?: string;
  kind?: 'form' | 'booking';
  fields?: FormField[];
  settings?: Partial<FormSettings>;
  notify?: Partial<FormNotify>;
}

interface UpdateFormDto {
  name?: string;
  description?: string;
  /** Renaming the public link. Rejected if taken — see FormsService.update. */
  slug?: string;
  fields?: FormField[];
  settings?: Partial<FormSettings>;
  notify?: Partial<FormNotify>;
  /**
   * Booking availability. `null` clears it ("no longer takes bookings"), which
   * is why the property is forwarded only when PRESENT — `undefined` has to
   * keep meaning "leave alone", and collapsing the two would wipe a form's
   * hours on every unrelated save.
   */
  availability?: Availability | null;
}

/**
 * Dashboard-facing CRUD for forms.
 *
 * Reached as `/api/forms/:path*` via the rewrite in apps/web/next.config.ts.
 * Public render + submit endpoints live in FormsPublicController (separate
 * controller, different auth, different guard shape) so a reader can tell
 * immediately which surface a handler belongs to.
 */
@Controller('forms')
@UseGuards(SupabaseAuthGuard)
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  async list(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<FormJson[]> {
    return this.forms.list(account.accountId);
  }

  @Get(':id')
  async get(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ): Promise<FormJson> {
    return this.forms.get(account.accountId, id);
  }

  @Post()
  @RequireRole('admin')
  async create(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: CreateFormDto,
  ): Promise<FormJson> {
    return this.forms.create(account.accountId, account.userId, {
      name: body.name,
      description: body.description,
      kind: body.kind,
      fields: body.fields,
      settings: body.settings,
      notify: body.notify,
    });
  }

  @Patch(':id')
  @RequireRole('admin')
  async update(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() body: UpdateFormDto,
  ): Promise<FormJson> {
    return this.forms.update(account.accountId, id, {
      name: body.name,
      description: body.description,
      slug: body.slug,
      fields: body.fields,
      settings: body.settings,
      notify: body.notify,
      // Spread so an absent key stays absent rather than becoming an explicit
      // `undefined` — see the DTO note on why null and undefined must differ.
      ...('availability' in body ? { availability: body.availability } : {}),
    });
  }

  @Post(':id/publish')
  @RequireRole('admin')
  async publish(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ): Promise<FormJson> {
    return this.forms.publish(account.accountId, id);
  }

  @Post(':id/unpublish')
  @RequireRole('admin')
  async unpublish(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ): Promise<FormJson> {
    return this.forms.unpublish(account.accountId, id);
  }

  @Post(':id/duplicate')
  @RequireRole('admin')
  async duplicate(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ): Promise<FormJson> {
    return this.forms.duplicate(account.accountId, account.userId, id);
  }

  @Delete(':id')
  @RequireRole('admin')
  async archive(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ): Promise<{ success: true }> {
    await this.forms.archive(account.accountId, id);
    return { success: true };
  }

  @Get(':id/submissions')
  async listSubmissions(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
  ) {
    return this.forms.listSubmissions(account.accountId, id);
  }
}
