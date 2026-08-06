import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { adsSandbox } from '../ads.config';
import { updateObjectStatus } from '../marketing-objects.util';
import { isSandboxId } from '../sandbox/fixtures';
import { AdsConfigService } from './ads-config.service';

/**
 * Pause / resume an existing campaign or ad.
 *
 * Separate from `AdPublishService` (which creates) because the risk
 * profile is different: pausing is safe and reversible, creating spends
 * money. Keeping them apart means the publish path's rollback machinery
 * does not sit in the way of a one-field update.
 *
 * ALWAYS SCOPED BY BOTH THE OBJECT AND THE ACCOUNT.
 *   Every lookup here filters on `account_id` as well as the id. Prisma
 *   bypasses RLS, so a uuid from another tenant would otherwise resolve —
 *   and this endpoint would then pause a stranger's live campaign.
 */
@Injectable()
export class AdsControlService {
  private readonly logger = new Logger(AdsControlService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AdsConfigService,
  ) {}

  async setCampaignStatus(args: {
    accountId: string;
    userId: string;
    campaignId: string;
    status: 'ACTIVE' | 'PAUSED';
  }): Promise<void> {
    const campaign = await this.prisma.meta_ads_campaigns.findFirst({
      where: { id: args.campaignId, account_id: args.accountId },
      select: { id: true, meta_campaign_id: true, name: true },
    });

    if (!campaign) throw new NotFoundException('Campaign not found.');

    await this.applyStatus({
      accountId: args.accountId,
      userId: args.userId,
      metaObjectId: campaign.meta_campaign_id,
      status: args.status,
      objectType: 'campaign',
      label: campaign.name,
    });

    await this.prisma.meta_ads_campaigns.update({
      where: { id: campaign.id },
      data: {
        status: args.status,
        // `effective_status` is Meta's to compute, and for a resume it
        // may legitimately stay PAUSED (a paused ad set beneath, an ad in
        // review). Writing our optimistic guess would make the UI claim
        // the ad is live when it isn't; the next sync fills in the truth.
        effective_status: args.status === 'PAUSED' ? 'PAUSED' : null,
        updated_at: new Date(),
      },
    });
  }

  async setAdStatus(args: {
    accountId: string;
    userId: string;
    adId: string;
    status: 'ACTIVE' | 'PAUSED';
  }): Promise<void> {
    const ad = await this.prisma.meta_ads_ads.findFirst({
      where: { id: args.adId, account_id: args.accountId },
      select: { id: true, meta_ad_id: true, name: true },
    });

    if (!ad) throw new NotFoundException('Ad not found.');

    await this.applyStatus({
      accountId: args.accountId,
      userId: args.userId,
      metaObjectId: ad.meta_ad_id,
      status: args.status,
      objectType: 'ad',
      label: ad.name,
    });

    await this.prisma.meta_ads_ads.update({
      where: { id: ad.id },
      data: {
        status: args.status,
        effective_status: args.status === 'PAUSED' ? 'PAUSED' : null,
        updated_at: new Date(),
      },
    });
  }

  /**
   * The Graph call plus its audit entry.
   *
   * Audited on failure as well as success: "who tried to turn this ad on
   * and why didn't it work" is exactly the question an incident asks.
   */
  private async applyStatus(args: {
    accountId: string;
    userId: string;
    metaObjectId: string;
    status: 'ACTIVE' | 'PAUSED';
    objectType: string;
    label: string;
  }): Promise<void> {
    // A sandbox id must never reach Graph — it would 400 at best, and at
    // worst collide with a real object id if Meta's namespace ever
    // overlapped our prefix.
    if (adsSandbox() || isSandboxId(args.metaObjectId)) {
      await this.config.audit({
        accountId: args.accountId,
        userId: args.userId,
        action: `${args.status === 'ACTIVE' ? 'resume' : 'pause'}_${args.objectType}`,
        objectType: args.objectType,
        objectId: args.metaObjectId,
        detail: { sandbox: true, label: args.label },
      });
      return;
    }

    const connection = await this.config.requireAdAccount(args.accountId);

    try {
      await updateObjectStatus({
        accessToken: connection.accessToken,
        objectId: args.metaObjectId,
        status: args.status,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Meta rejected the change.';

      await this.config.audit({
        accountId: args.accountId,
        userId: args.userId,
        action: `${args.status === 'ACTIVE' ? 'resume' : 'pause'}_${args.objectType}`,
        objectType: args.objectType,
        objectId: args.metaObjectId,
        detail: { label: args.label },
        succeeded: false,
        error: message,
      });

      this.logger.warn(
        `Failed to set ${args.objectType} ${args.metaObjectId} to ${args.status}: ${message}`,
      );
      throw new BadRequestException(message);
    }

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: `${args.status === 'ACTIVE' ? 'resume' : 'pause'}_${args.objectType}`,
      objectType: args.objectType,
      objectId: args.metaObjectId,
      detail: { label: args.label },
    });
  }
}
