import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { AdsEnabledGuard } from '../guards/ads-enabled.guard';
import {
  EstimateReachDto,
  PreviewAdDto,
  PublishAdDto,
} from '../dto/ads-publish.dto';
import { SPECIAL_AD_CATEGORIES } from '../dto/ads-publish.dto';
import { AD_TYPES, AD_TYPE_ORDER, type AdTypeId } from '../services/ad-types';
import { PIXEL_EVENTS } from '../services/ad-types/website.builder';
import { AdPublishService } from '../services/ad-publish.service';
import { AdsTargetingService } from '../services/ads-targeting.service';
import { AdsConfigService } from '../services/ads-config.service';

/**
 * `/ads/ad-types`, `/ads/publish`, `/ads/reach-estimate` — the wizard's
 * own surface.
 *
 * Publishing is `admin`+: it spends money from the connected ad account.
 * Reading the type catalogue is open, because the wizard's first screen is
 * how anyone finds out what the feature does.
 */
@Controller('ads')
@UseGuards(AdsEnabledGuard, SupabaseAuthGuard)
export class AdsPublishController {
  constructor(
    private readonly publishService: AdPublishService,
    private readonly targeting: AdsTargetingService,
    private readonly config: AdsConfigService,
  ) {}

  /**
   * GET /api/ads/ad-types
   *
   * The catalogue the wizard's first step renders: which types exist,
   * which are usable by THIS workspace, and why not when they are not.
   *
   * Derived from the same builders that validate a publish, so the UI can
   * never offer a goal or a type the API would reject — the whole reason
   * the registry exposes `performanceGoals` and `unavailableReason`.
   */
  @Get('ad-types')
  async adTypes(@CurrentAccount() account: SupabaseAccountContext) {
    const connection = await this.config.findConnection(account.accountId);

    // A partial context is fine here: `unavailableReason` only reads the
    // asset fields, and an unconnected workspace should still see the
    // catalogue with everything explained rather than an error.
    const context = {
      adAccountId: connection?.adAccountId ?? '',
      pageId: connection?.pageId ?? '',
      whatsappPhoneNumberId: connection?.whatsappPhoneNumberId ?? null,
      whatsappDisplayNumber: connection?.whatsappDisplayNumber ?? null,
      pixelId: connection?.pixelId ?? null,
      currency: connection?.currency ?? null,
      timezoneName: connection?.timezoneName ?? null,
      instagramActorId: null,
    };

    return {
      specialAdCategories: SPECIAL_AD_CATEGORIES,
      // Served alongside the types so the wizard's conversion-event picker
      // is built from the same list `requirePixelForConversions` validates
      // against — a UI offering an event the builder rejects would fail
      // after the campaign is already created.
      pixelEvents: PIXEL_EVENTS,
      pixelSelected: Boolean(connection?.pixelId),
      adTypes: AD_TYPE_ORDER.map((id) => {
        const builder = AD_TYPES[id];
        return {
          id: builder.id,
          label: builder.label,
          description: builder.description,
          objective: builder.objective,
          performanceGoals: builder.performanceGoals,
          callToActions: builder.callToActions,
          needsLink: builder.needsLink,
          needsWhatsApp: builder.needsWhatsApp,
          needsLeadForm: builder.needsLeadForm,
          needsPixel: builder.needsPixel,
          unavailableReason: builder.unavailableReason(context),
        };
      }),
    };
  }

  /**
   * POST /api/ads/reach-estimate
   *
   * The audience size for a targeting spec, before anything is created.
   * Takes the optimisation goal too — the addressable audience for
   * `CONVERSATIONS` is narrower than for `REACH`, because Meta only counts
   * people it believes can perform the optimised action.
   */
  @Post('reach-estimate')
  async reachEstimate(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: EstimateReachDto,
  ) {
    return this.targeting.estimateReach({
      accountId: account.accountId,
      adType: dto.adType as AdTypeId,
      optimizationGoal: dto.optimizationGoal,
      targeting: dto.targeting,
    });
  }

  /**
   * POST /api/ads/preview
   *
   * Meta's own rendering of the creative, as a URL the client opens in a new
   * tab. Not embedded — see `AdPublishService.previewUrl` for why an iframe
   * would break when the CSP is enforced.
   */
  @Post('preview')
  async preview(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: PreviewAdDto,
  ) {
    return this.publishService.previewUrl({
      accountId: account.accountId,
      adType: dto.adType as AdTypeId,
      adFormat: dto.adFormat,
      input: {
        campaignName: dto.campaignName,
        specialAdCategories: dto.specialAdCategories,
        optimizationGoal: dto.optimizationGoal,
        budget: dto.budget,
        targeting: this.targeting.toTargetingInput(dto.targeting),
        creative: dto.creative,
      },
    });
  }

  /**
   * POST /api/ads/publish
   *
   * Creates campaign → ad set → creative → ad, all PAUSED, mirrors them in
   * one transaction, then activates. See `AdPublishService` for why that
   * order is not negotiable.
   */
  @Post('publish')
  @RequireRole('admin')
  async publish(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() dto: PublishAdDto,
  ) {
    return this.publishService.publish({
      accountId: account.accountId,
      userId: account.userId,
      adType: dto.adType as AdTypeId,
      input: {
        campaignName: dto.campaignName,
        specialAdCategories: dto.specialAdCategories,
        optimizationGoal: dto.optimizationGoal,
        budget: dto.budget,
        targeting: this.targeting.toTargetingInput(dto.targeting),
        creative: dto.creative,
      },
    });
  }
}
