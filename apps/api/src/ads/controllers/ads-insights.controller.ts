import {
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
import { AdsRangeQueryDto, SetObjectStatusDto } from '../dto/ads-query.dto';
import {
  AdsInsightsService,
  type AdsDateRange,
  type AdsOverview,
} from '../services/ads-insights.service';
import { AdsControlService } from '../services/ads-control.service';
import { AdsSyncProcessor } from '../ads-sync.processor';

/** How many days the Overview shows when no range is given. */
const DEFAULT_RANGE_DAYS = 7;

/** Hard cap on a requested window. */
const MAX_RANGE_DAYS = 400;

/**
 * `/ads/insights`, `/ads/campaigns` — the read + control surface.
 *
 * Reads are open to any member: whether the workspace's ads are
 * delivering is not privileged information, and hiding spend from the
 * people running the inbox makes the attribution useless. Pausing or
 * resuming is `admin`+, matching the RLS in migration 068.
 *
 * Every figure comes from the local mirror, never from Graph. The
 * refresh endpoint enqueues a sync instead of syncing inline, so a page
 * load can never be blocked by Meta's rate limiter.
 */
@Controller('ads')
@UseGuards(AdsEnabledGuard, SupabaseAuthGuard)
export class AdsInsightsController {
  constructor(
    private readonly insights: AdsInsightsService,
    private readonly control: AdsControlService,
    private readonly sync: AdsSyncProcessor,
  ) {}

  /** GET /api/ads/overview?since=&until= */
  @Get('overview')
  async overview(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query() query: AdsRangeQueryDto,
  ): Promise<AdsOverview> {
    return this.insights.getOverview(account.accountId, resolveRange(query));
  }

  /**
   * GET /api/ads/leads?since=&until=
   *
   * Ad spend attributed to the contacts and deals it produced. Open to
   * every member: the point of this surface is that the people working the
   * inbox can see which ads their conversations came from.
   */
  @Get('leads')
  async leads(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query() query: AdsRangeQueryDto,
  ) {
    return this.insights.getLeads(account.accountId, resolveRange(query));
  }

  /** GET /api/ads/campaigns/:campaignId/ads?since=&until= */
  @Get('campaigns/:campaignId/ads')
  async campaignAds(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('campaignId') campaignId: string,
    @Query() query: AdsRangeQueryDto,
  ) {
    return this.insights.getCampaignAds(
      account.accountId,
      campaignId,
      resolveRange(query),
    );
  }

  /**
   * POST /api/ads/sync — on-demand refresh.
   *
   * Returns immediately with `{ queued: true }`. The per-account job id
   * collapses a burst of clicks into one sync, so the button cannot be
   * used to hammer Meta and throttle the whole workspace.
   */
  @Post('sync')
  @RequireRole('agent')
  async refresh(
    @CurrentAccount() account: SupabaseAccountContext,
  ): Promise<{ queued: true }> {
    await this.sync.enqueueAccount(account.accountId);
    return { queued: true };
  }

  /** POST /api/ads/campaigns/:campaignId/status */
  @Post('campaigns/:campaignId/status')
  @RequireRole('admin')
  async setCampaignStatus(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('campaignId') campaignId: string,
    @Body() dto: SetObjectStatusDto,
  ): Promise<{ ok: true }> {
    await this.control.setCampaignStatus({
      accountId: account.accountId,
      userId: account.userId,
      campaignId,
      status: dto.status,
    });
    return { ok: true };
  }

  /** POST /api/ads/ads/:adId/status */
  @Post('ads/:adId/status')
  @RequireRole('admin')
  async setAdStatus(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('adId') adId: string,
    @Body() dto: SetObjectStatusDto,
  ): Promise<{ ok: true }> {
    await this.control.setAdStatus({
      accountId: account.accountId,
      userId: account.userId,
      adId,
      status: dto.status,
    });
    return { ok: true };
  }
}

/**
 * Turn the optional query into a concrete, bounded range.
 *
 * Clamped rather than rejected when the window is absurd: a bookmarked
 * URL with a two-year range should render the last 400 days, not a
 * validation error the user cannot act on. The cap exists because the
 * query scans daily rows per object and an unbounded range is an
 * accidental table scan.
 */
export function resolveRange(query: AdsRangeQueryDto): AdsDateRange {
  const today = new Date();
  const until = query.until ?? isoDate(today);

  const defaultSince = new Date(today);
  defaultSince.setUTCDate(defaultSince.getUTCDate() - (DEFAULT_RANGE_DAYS - 1));
  let since = query.since ?? isoDate(defaultSince);

  // A reversed range is a UI slip, not an attack — swap rather than 400.
  if (since > until) {
    const swap = since;
    since = until;
    return { since: until, until: swap };
  }

  const spanDays =
    (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) /
      86_400_000 +
    1;

  if (spanDays > MAX_RANGE_DAYS) {
    const clamped = new Date(`${until}T00:00:00Z`);
    clamped.setUTCDate(clamped.getUTCDate() - (MAX_RANGE_DAYS - 1));
    return { since: isoDate(clamped), until };
  }

  return { since, until };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
