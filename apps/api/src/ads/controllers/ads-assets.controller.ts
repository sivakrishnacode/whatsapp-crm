import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { AdsEnabledGuard } from '../guards/ads-enabled.guard';
import type { LeadFormQuestion } from '../marketing-leadforms.util';
import {
  CreateAudienceFromContactsDto,
  CreateLeadFormDto,
  CreateLookalikeDto,
  CreateSavedAudienceDto,
  SearchTargetingQueryDto,
  UploadAdMediaDto,
} from '../dto/ads-assets.dto';
import { AdsAssetsService } from '../services/ads-assets.service';
import { AdsTargetingService } from '../services/ads-targeting.service';
import { buildTargeting } from '../services/ad-types/shared';

/**
 * `/ads/media`, `/ads/lead-forms`, `/ads/audiences`, `/ads/search-*` —
 * the assets an ad references.
 *
 * Uploading a creative is `agent`+: an image costs nothing until an ad
 * uses it, matching the RLS on `meta_ads_media` in migration 068.
 * Creating a lead form or an audience is `admin`+ — both are page- or
 * account-level objects that outlive any one ad, and an audience upload
 * sends customer identifiers to Meta.
 */
@Controller('ads')
@UseGuards(AdsEnabledGuard, SupabaseAuthGuard)
export class AdsAssetsController {
  constructor(
    private readonly assets: AdsAssetsService,
    private readonly targeting: AdsTargetingService,
  ) {}

  // ------------------------------------------------------------
  // Targeting search
  // ------------------------------------------------------------

  @Get('search-locations')
  async searchLocations(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query() query: SearchTargetingQueryDto,
  ) {
    return {
      data: await this.targeting.searchLocations({
        accountId: account.accountId,
        query: query.q,
        types: query.types,
      }),
    };
  }

  @Get('search-interests')
  async searchInterests(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query() query: SearchTargetingQueryDto,
  ) {
    return {
      data: await this.targeting.searchInterests({
        accountId: account.accountId,
        query: query.q,
      }),
    };
  }

  // ------------------------------------------------------------
  // Media
  // ------------------------------------------------------------

  @Get('media')
  async listMedia(@CurrentAccount() account: SupabaseAccountContext) {
    return { data: await this.assets.listMedia(account.accountId) };
  }

  /**
   * POST /api/ads/media — base64 in a JSON body.
   *
   * Not multipart: this API has no multipart parser, and the same choice
   * is already made for widget attachments (`UploadWebMediaDto`). The
   * DTO's string cap bounds the request; the service enforces the real
   * per-type byte limits, which differ between an image and a video.
   */
  @Post('media')
  @RequireRole('agent')
  async uploadMedia(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: UploadAdMediaDto,
  ) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(dto.dataBase64, 'base64');
    } catch {
      throw new BadRequestException('That file could not be read.');
    }

    if (bytes.byteLength === 0) {
      // `Buffer.from` does not throw on malformed base64 — it returns
      // whatever it could decode, which for junk input is empty. Without
      // this check we would upload a 0-byte file and let Meta produce the
      // error.
      throw new BadRequestException(
        'That file could not be read. Try selecting it again.',
      );
    }

    return this.assets.uploadMedia({
      accountId: account.accountId,
      userId: account.userId,
      bytes,
      filename: dto.filename || 'upload',
      contentType: dto.contentType,
    });
  }

  /** GET /api/ads/media/video/:videoId — has Meta finished transcoding? */
  @Get('media/video/:videoId')
  async videoStatus(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('videoId') videoId: string,
  ) {
    return this.assets.videoStatus(account.accountId, videoId);
  }

  // ------------------------------------------------------------
  // Lead forms
  // ------------------------------------------------------------

  @Get('lead-forms')
  async listLeadForms(@CurrentAccount() account: SupabaseAccountContext) {
    return { data: await this.assets.listLeadForms(account.accountId) };
  }

  @Post('lead-forms')
  @RequireRole('admin')
  async createLeadForm(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: CreateLeadFormDto,
  ) {
    return this.assets.createLeadForm({
      accountId: account.accountId,
      userId: account.userId,
      name: dto.name,
      questions: dto.questions as LeadFormQuestion[],
      privacyPolicyUrl: dto.privacyPolicyUrl,
      thankYouTitle: dto.thankYouTitle,
      thankYouBody: dto.thankYouBody,
    });
  }

  // ------------------------------------------------------------
  // Audiences
  // ------------------------------------------------------------

  @Get('audiences')
  async listAudiences(@CurrentAccount() account: SupabaseAccountContext) {
    return this.assets.listAudiences(account.accountId);
  }

  /**
   * POST /api/ads/audiences/from-contacts
   *
   * Builds a Meta custom audience from this workspace's contacts. Phone
   * numbers are SHA-256 hashed before they leave the process — see
   * `hashAudienceIdentifier`.
   */
  @Post('audiences/from-contacts')
  @RequireRole('admin')
  async createFromContacts(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: CreateAudienceFromContactsDto,
  ) {
    return this.assets.createAudienceFromContacts({
      accountId: account.accountId,
      userId: account.userId,
      name: dto.name,
      tagIds: dto.tagIds,
      includeEmails: dto.includeEmails,
    });
  }

  /**
   * POST /api/ads/audiences/saved
   *
   * Stores the wizard's current targeting for reuse. `agent`+ rather than
   * `admin`: a saved audience is a targeting preset that costs nothing and
   * shares no customer data, unlike a custom audience upload.
   */
  @Post('audiences/saved')
  @RequireRole('agent')
  async createSavedAudience(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: CreateSavedAudienceDto,
  ) {
    return this.assets.createSavedAudienceFromTargeting({
      accountId: account.accountId,
      userId: account.userId,
      name: dto.name,
      // Through the same two functions the publish path uses, so a saved
      // audience cannot encode targeting an ad set could not.
      targeting: buildTargeting(this.targeting.toTargetingInput(dto.targeting)),
    });
  }

  /**
   * POST /api/ads/audiences/:audienceId/refresh
   *
   * Re-uploads a CRM audience from the segment recorded in
   * `filter_criteria`. Only works for audiences we built.
   */
  @Post('audiences/:audienceId/refresh')
  @RequireRole('admin')
  async refreshAudience(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('audienceId') audienceId: string,
  ) {
    return this.assets.refreshAudience({
      accountId: account.accountId,
      userId: account.userId,
      audienceId,
    });
  }

  @Post('audiences/lookalike')
  @RequireRole('admin')
  async createLookalike(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: CreateLookalikeDto,
  ) {
    return this.assets.createLookalike({
      accountId: account.accountId,
      userId: account.userId,
      name: dto.name,
      sourceAudienceId: dto.sourceAudienceId,
      country: dto.country,
      ratio: dto.ratio,
    });
  }
}
