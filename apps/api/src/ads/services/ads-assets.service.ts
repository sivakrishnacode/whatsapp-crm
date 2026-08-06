import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { adsSandbox } from '../ads.config';
import {
  AD_IMAGE_TYPES,
  AD_VIDEO_TYPES,
  MAX_AD_IMAGE_BYTES,
  MAX_AD_VIDEO_BYTES,
  getAdVideoStatus,
  listAdImages,
  uploadAdImage,
  uploadAdVideo,
} from '../marketing-media.util';
import {
  createLeadGenForm,
  getLeadGenForms,
  type LeadFormQuestion,
  type MetaLeadForm,
} from '../marketing-leadforms.util';
import {
  addUsersToAudience,
  createCustomAudience,
  createLookalikeAudience,
  createSavedAudience,
  getCustomAudiences,
  getSavedAudiences,
  type AudienceSchemaField,
  type MetaAudience,
  type MetaSavedAudience,
} from '../marketing-audiences.util';
import {
  SANDBOX_AUDIENCES,
  SANDBOX_LEAD_FORMS,
  SANDBOX_PREFIX,
} from '../sandbox/fixtures';
import { toJson } from '../utils/prisma-json.util';
import { AdsConfigService } from './ads-config.service';

/**
 * Creative media, Meta lead forms and audiences — the three asset kinds
 * an ad references but which are not the ad itself.
 *
 * One service rather than three because they share the same shape (list /
 * create / mirror locally) and the same two preconditions (a connected ad
 * account, and a page token for anything page-scoped). Three near-identical
 * services would be three places to forget the page-token rule.
 */
@Injectable()
export class AdsAssetsService {
  private readonly logger = new Logger(AdsAssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AdsConfigService,
  ) {}

  // ============================================================
  // Media
  // ============================================================

  /**
   * Upload an image or video to the ad account.
   *
   * Validated before the upload rather than after: Meta's error for an
   * oversized or wrong-typed file is generic, and by then the user has
   * already waited for the transfer.
   */
  async uploadMedia(args: {
    accountId: string;
    userId: string;
    bytes: Buffer;
    filename: string;
    contentType: string;
  }): Promise<{
    kind: 'image' | 'video';
    imageHash?: string;
    videoId?: string;
    url: string | null;
    /** Videos transcode asynchronously — false means "poll before publishing". */
    ready: boolean;
  }> {
    const isImage = (AD_IMAGE_TYPES as readonly string[]).includes(
      args.contentType,
    );
    const isVideo = (AD_VIDEO_TYPES as readonly string[]).includes(
      args.contentType,
    );

    if (!isImage && !isVideo) {
      throw new BadRequestException(
        `Meta accepts JPEG or PNG images and MP4 or MOV videos. That file is ${args.contentType || 'of an unknown type'}.`,
      );
    }

    const limit = isImage ? MAX_AD_IMAGE_BYTES : MAX_AD_VIDEO_BYTES;
    if (args.bytes.byteLength > limit) {
      throw new BadRequestException(
        `That file is ${Math.round(args.bytes.byteLength / 1024 / 1024)} MB. The limit is ${Math.round(limit / 1024 / 1024)} MB.`,
      );
    }

    const connection = await this.config.requireAdAccount(args.accountId);

    if (adsSandbox()) {
      // A deterministic fake hash so the wizard's preview and publish both
      // work end to end without an upload leaving the machine.
      const fake = `${SANDBOX_PREFIX}media_${Date.now().toString(36)}`;
      await this.recordMedia({
        accountId: args.accountId,
        userId: args.userId,
        kind: isImage ? 'image' : 'video',
        imageHash: isImage ? fake : undefined,
        videoId: isVideo ? fake : undefined,
        name: args.filename,
        url: null,
      });
      return {
        kind: isImage ? 'image' : 'video',
        imageHash: isImage ? fake : undefined,
        videoId: isVideo ? fake : undefined,
        url: null,
        ready: true,
      };
    }

    if (isImage) {
      const uploaded = await uploadAdImage({
        accessToken: connection.accessToken,
        adAccountId: connection.adAccountId,
        bytes: args.bytes,
        filename: args.filename,
        contentType: args.contentType,
      });

      await this.recordMedia({
        accountId: args.accountId,
        userId: args.userId,
        kind: 'image',
        imageHash: uploaded.hash,
        name: uploaded.name,
        url: uploaded.url,
        width: uploaded.width,
        height: uploaded.height,
      });

      return {
        kind: 'image',
        imageHash: uploaded.hash,
        url: uploaded.url,
        ready: true,
      };
    }

    const uploaded = await uploadAdVideo({
      accessToken: connection.accessToken,
      adAccountId: connection.adAccountId,
      bytes: args.bytes,
      filename: args.filename,
      contentType: args.contentType,
    });

    await this.recordMedia({
      accountId: args.accountId,
      userId: args.userId,
      kind: 'video',
      videoId: uploaded.videoId,
      name: uploaded.name,
      url: null,
    });

    // Never `ready: true` for a fresh video. Meta transcodes
    // asynchronously and a creative built against an unprocessed video
    // fails — the wizard polls `videoStatus` before enabling Publish.
    return {
      kind: 'video',
      videoId: uploaded.videoId,
      url: null,
      ready: false,
    };
  }

  async videoStatus(
    accountId: string,
    videoId: string,
  ): Promise<{ ready: boolean; status: string; thumbnailUrl: string | null }> {
    if (adsSandbox()) {
      return { ready: true, status: 'ready', thumbnailUrl: null };
    }
    const connection = await this.config.requireConnection(accountId);
    return getAdVideoStatus({
      accessToken: connection.accessToken,
      videoId,
    });
  }

  /**
   * The media library.
   *
   * Reads the local mirror first and only falls back to Graph when it is
   * empty — the mirror exists so opening the picker is not a Graph call
   * against a rate limit the whole workspace shares.
   */
  async listMedia(accountId: string): Promise<
    Array<{
      id: string;
      kind: string;
      imageHash: string | null;
      videoId: string | null;
      name: string | null;
      url: string | null;
    }>
  > {
    const local = await this.prisma.meta_ads_media.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      take: 60,
    });

    if (local.length > 0 || adsSandbox()) {
      return local.map((row) => ({
        id: row.id,
        kind: row.kind,
        imageHash: row.meta_image_hash,
        videoId: row.meta_video_id,
        name: row.name,
        url: row.permalink_url,
      }));
    }

    // First use on an account that already has creatives in Meta —
    // backfill so the picker is not empty on day one.
    const connection = await this.config.requireAdAccount(accountId);
    const images = await listAdImages({
      accessToken: connection.accessToken,
      adAccountId: connection.adAccountId,
    });

    for (const image of images) {
      await this.recordMedia({
        accountId,
        userId: null,
        kind: 'image',
        imageHash: image.hash,
        name: image.name,
        url: image.url,
        width: image.width,
        height: image.height,
      });
    }

    return images.map((image) => ({
      id: image.hash,
      kind: 'image',
      imageHash: image.hash,
      videoId: null,
      name: image.name,
      url: image.url,
    }));
  }

  /** Upsert on the account-scoped unique index from migration 068. */
  private async recordMedia(args: {
    accountId: string;
    userId: string | null;
    kind: 'image' | 'video';
    imageHash?: string;
    videoId?: string;
    name: string;
    url: string | null;
    width?: number | null;
    height?: number | null;
  }): Promise<void> {
    try {
      const existing = await this.prisma.meta_ads_media.findFirst({
        where: {
          account_id: args.accountId,
          ...(args.imageHash
            ? { meta_image_hash: args.imageHash }
            : { meta_video_id: args.videoId }),
        },
        select: { id: true },
      });

      if (existing) return;

      await this.prisma.meta_ads_media.create({
        data: {
          account_id: args.accountId,
          kind: args.kind,
          meta_image_hash: args.imageHash ?? null,
          meta_video_id: args.videoId ?? null,
          name: args.name,
          permalink_url: args.url,
          width: args.width ?? null,
          height: args.height ?? null,
          uploaded_by: args.userId,
        },
      });
    } catch (err) {
      // The asset is already in Meta and usable; the index is a
      // convenience. Failing the upload over it would throw away a
      // successful transfer.
      this.logger.warn(
        `Uploaded media for account ${args.accountId} but could not index it locally.`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ============================================================
  // Lead forms
  // ============================================================

  async listLeadForms(accountId: string): Promise<MetaLeadForm[]> {
    if (adsSandbox()) {
      return SANDBOX_LEAD_FORMS.map((form) => ({
        id: form.id,
        name: form.name,
        status: form.status,
        questions: form.questions.map((q) => ({
          key: q.key,
          type: q.type,
          label: q.label,
        })),
        privacyPolicyUrl: form.privacyPolicyUrl,
        leadsCount: form.leadsCount,
      }));
    }

    const { pageId, pageAccessToken } = await this.requirePage(accountId);
    const forms = await getLeadGenForms({ pageAccessToken, pageId });

    // Mirror so the wizard's dropdown and the Lead Forms page do not both
    // page the Graph API.
    for (const form of forms) {
      await this.prisma.meta_lead_forms.upsert({
        where: { meta_form_id: form.id },
        create: {
          account_id: accountId,
          page_id: pageId,
          meta_form_id: form.id,
          name: form.name,
          status: form.status,
          questions: toJson(form.questions) ?? [],
          privacy_policy_url: form.privacyPolicyUrl,
          leads_count: form.leadsCount,
          synced_at: new Date(),
        },
        update: {
          name: form.name,
          status: form.status,
          questions: toJson(form.questions) ?? [],
          privacy_policy_url: form.privacyPolicyUrl,
          leads_count: form.leadsCount,
          synced_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    return forms;
  }

  /**
   * Create an instant form on the connected page.
   *
   * ⚠️ A form with no phone question produces leads this CRM cannot store.
   *   `FacebookLeadsWebhookController.processLead` skips a lead with no
   *   usable phone number, because `contacts` requires a phone, an IGSID or
   *   a web visitor id and a lead has none of the other two. So a phone
   *   question is added when the caller omitted one, rather than letting
   *   the user build a form whose submissions silently vanish.
   */
  async createLeadForm(args: {
    accountId: string;
    userId: string;
    name: string;
    questions: LeadFormQuestion[];
    privacyPolicyUrl: string;
    thankYouTitle?: string;
    thankYouBody?: string;
  }): Promise<{ id: string; addedPhoneQuestion: boolean }> {
    const questions = [...args.questions];
    const hasPhone = questions.some((q) => q.type === 'PHONE');

    if (!hasPhone) questions.push({ type: 'PHONE' });

    if (adsSandbox()) {
      return {
        id: `${SANDBOX_PREFIX}form_${Date.now().toString(36)}`,
        addedPhoneQuestion: !hasPhone,
      };
    }

    const { pageId, pageAccessToken } = await this.requirePage(args.accountId);

    const created = await createLeadGenForm({
      pageAccessToken,
      pageId,
      name: args.name,
      questions,
      privacyPolicyUrl: args.privacyPolicyUrl,
      thankYouTitle: args.thankYouTitle,
      thankYouBody: args.thankYouBody,
    });

    await this.prisma.meta_lead_forms.create({
      data: {
        account_id: args.accountId,
        page_id: pageId,
        meta_form_id: created.id,
        name: args.name,
        status: 'ACTIVE',
        questions: toJson(questions) ?? [],
        privacy_policy_url: args.privacyPolicyUrl,
        synced_at: new Date(),
      },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'create_lead_form',
      objectType: 'lead_form',
      objectId: created.id,
      detail: { question_types: questions.map((q) => q.type) },
    });

    return { id: created.id, addedPhoneQuestion: !hasPhone };
  }

  // ============================================================
  // Audiences
  // ============================================================

  async listAudiences(accountId: string): Promise<{
    custom: MetaAudience[];
    saved: MetaSavedAudience[];
  }> {
    if (adsSandbox()) {
      return {
        custom: SANDBOX_AUDIENCES.map((a) => ({
          id: a.id,
          name: a.name,
          subtype: a.subtype,
          approximateCount: a.approximateCount,
          deliveryStatus: a.deliveryStatus,
          sourceAudienceId: a.sourceAudienceId,
          description: null,
        })),
        saved: [],
      };
    }

    const connection = await this.config.requireAdAccount(accountId);

    const [custom, saved] = await Promise.all([
      getCustomAudiences({
        accessToken: connection.accessToken,
        adAccountId: connection.adAccountId,
      }),
      // Saved audiences are a separate, less-used edge; a failure there
      // should not empty the custom-audience list beside it.
      getSavedAudiences({
        accessToken: connection.accessToken,
        adAccountId: connection.adAccountId,
      }).catch(() => [] as MetaSavedAudience[]),
    ]);

    for (const audience of custom) {
      await this.prisma.meta_ad_audiences.upsert({
        where: { meta_audience_id: audience.id },
        create: {
          account_id: accountId,
          meta_audience_id: audience.id,
          name: audience.name,
          subtype: normaliseSubtype(audience.subtype),
          origin: 'meta',
          approximate_count: audience.approximateCount,
          delivery_status: audience.deliveryStatus,
          source_audience_id: audience.sourceAudienceId,
          last_synced_at: new Date(),
        },
        update: {
          name: audience.name,
          approximate_count: audience.approximateCount,
          delivery_status: audience.deliveryStatus,
          last_synced_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    return { custom, saved };
  }

  /**
   * Build a custom audience from this workspace's own contacts.
   *
   * Phone numbers only, and hashed inside `addUsersToAudience` — plaintext
   * identifiers never leave this method. `contacts.phone` is already
   * stored E.164 (migration 061), which is most of the normalisation Meta
   * needs.
   *
   * A count is reported back including how many contacts were SKIPPED,
   * because "uploaded 4,000 of 4,200" is actionable and "uploaded" is not.
   */
  async createAudienceFromContacts(args: {
    accountId: string;
    userId: string;
    name: string;
    /** Optional tag filter; omit for every contact with a phone number. */
    tagIds?: string[];
    /**
     * Also upload email addresses as a second schema.
     *
     * Off by default: a phone number is the identifier this CRM always has
     * (contacts require one), while emails are patchy — and each schema is
     * a separate upload, so including empty ones costs calls for nothing.
     */
    includeEmails?: boolean;
  }): Promise<{
    audienceId: string;
    uploaded: number;
    skipped: number;
    /** True when Meta will likely refuse to build a lookalike from this. */
    tooSmallForLookalike: boolean;
  }> {
    const contacts = await this.prisma.contacts.findMany({
      where: {
        account_id: args.accountId,
        phone: { not: null },
        ...(args.tagIds?.length
          ? { contact_tags: { some: { tag_id: { in: args.tagIds } } } }
          : {}),
      },
      select: { phone: true, email: true },
      // A hard cap: a segment of a million contacts is a job, not a
      // request, and an unbounded findMany would hold it all in memory.
      take: 50_000,
    });

    const phones = contacts
      .map((c) => c.phone)
      .filter((p): p is string => Boolean(p));

    const emails = args.includeEmails
      ? contacts.map((c) => c.email).filter((e): e is string => Boolean(e))
      : [];

    if (phones.length === 0) {
      throw new BadRequestException(
        'No contacts with a phone number match that selection, so there is nothing to upload.',
      );
    }

    if (adsSandbox()) {
      const id = `${SANDBOX_PREFIX}aud_${Date.now().toString(36)}`;
      await this.recordCrmAudience({
        accountId: args.accountId,
        audienceId: id,
        name: args.name,
        count: phones.length,
        tagIds: args.tagIds,
      });
      return {
        audienceId: id,
        uploaded: phones.length,
        skipped: 0,
        tooSmallForLookalike: phones.length < 100,
      };
    }

    const connection = await this.config.requireAdAccount(args.accountId);

    const audience = await createCustomAudience({
      accessToken: connection.accessToken,
      adAccountId: connection.adAccountId,
      name: args.name,
      description: `Built from ${phones.length} CRM contacts`,
    });

    // One upload per schema. Meta matches each independently, so a contact
    // with both a phone and an email is more likely to be found — but the
    // counts are per identifier, not per person, so they are summed for
    // reporting rather than presented as a headcount.
    const uploads: Array<{
      field: AudienceSchemaField;
      identifiers: string[];
    }> = [{ field: 'PHONE', identifiers: phones }];
    if (emails.length) uploads.push({ field: 'EMAIL', identifiers: emails });

    let received = 0;
    let skipped = 0;
    for (const upload of uploads) {
      const batch = await addUsersToAudience({
        accessToken: connection.accessToken,
        audienceId: audience.id,
        field: upload.field,
        identifiers: upload.identifiers,
      });
      received += batch.received;
      skipped += batch.skipped;
    }

    const result = { received, skipped };

    await this.recordCrmAudience({
      accountId: args.accountId,
      audienceId: audience.id,
      name: args.name,
      count: phones.length,
      tagIds: args.tagIds,
      includeEmails: args.includeEmails,
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'create_audience_from_contacts',
      objectType: 'audience',
      objectId: audience.id,
      detail: {
        uploaded: result.received,
        skipped: result.skipped,
        tag_ids: args.tagIds ?? null,
        included_emails: Boolean(args.includeEmails),
      },
    });

    return {
      audienceId: audience.id,
      uploaded: result.received,
      skipped: result.skipped,
      // Meta needs roughly 100 MATCHED people to grow a lookalike, and
      // matching is always lossy — so warn well above the documented floor.
      tooSmallForLookalike: result.received < 100,
    };
  }

  /**
   * Save the wizard's current targeting for reuse.
   *
   * Stores the same `targeting` object an ad set takes, so whatever step 2
   * built is persisted verbatim. Mirrored locally with subtype 'SAVED' so
   * the targeting step can offer it without a Graph call.
   */
  async createSavedAudienceFromTargeting(args: {
    accountId: string;
    userId: string;
    name: string;
    targeting: Record<string, unknown>;
  }): Promise<{ audienceId: string }> {
    if (adsSandbox()) {
      const id = `${SANDBOX_PREFIX}saved_${Date.now().toString(36)}`;
      await this.prisma.meta_ad_audiences.create({
        data: {
          account_id: args.accountId,
          meta_audience_id: id,
          name: args.name,
          subtype: 'SAVED',
          origin: 'crm',
          filter_criteria: toJson(args.targeting),
          last_synced_at: new Date(),
        },
      });
      return { audienceId: id };
    }

    const connection = await this.config.requireAdAccount(args.accountId);

    const created = await createSavedAudience({
      accessToken: connection.accessToken,
      adAccountId: connection.adAccountId,
      name: args.name,
      targeting: args.targeting,
    });

    await this.prisma.meta_ad_audiences.create({
      data: {
        account_id: args.accountId,
        meta_audience_id: created.id,
        name: args.name,
        subtype: 'SAVED',
        origin: 'crm',
        filter_criteria: toJson(args.targeting),
        last_synced_at: new Date(),
      },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'create_saved_audience',
      objectType: 'audience',
      objectId: created.id,
    });

    return { audienceId: created.id };
  }

  /**
   * Re-upload a CRM audience from its stored segment.
   *
   * This is what `filter_criteria` was written for: a 'crm' audience knows
   * which tag filter produced it, so it can be brought up to date as
   * contacts are added. A 'meta' audience has no local source and is
   * refused rather than silently doing nothing.
   *
   * Adds only. Meta's replace flow needs a multi-batch `session`, and
   * removing people who left a segment is a different product decision —
   * an audience someone was in yesterday is arguably still a fair thing to
   * advertise to. Stated here so the behaviour is deliberate.
   */
  async refreshAudience(args: {
    accountId: string;
    userId: string;
    audienceId: string;
  }): Promise<{ uploaded: number; skipped: number }> {
    const audience = await this.prisma.meta_ad_audiences.findFirst({
      where: {
        account_id: args.accountId,
        meta_audience_id: args.audienceId,
      },
      select: {
        id: true,
        origin: true,
        subtype: true,
        filter_criteria: true,
      },
    });

    if (!audience) {
      throw new NotFoundException('That audience is not on this ad account.');
    }

    if (audience.origin !== 'crm' || audience.subtype !== 'CUSTOM') {
      throw new BadRequestException(
        'Only audiences built from your contacts can be refreshed. This one has no segment to rebuild from.',
      );
    }

    const criteria = (audience.filter_criteria ?? {}) as {
      tag_ids?: string[] | null;
      include_emails?: boolean;
    };

    const contacts = await this.prisma.contacts.findMany({
      where: {
        account_id: args.accountId,
        phone: { not: null },
        ...(criteria.tag_ids?.length
          ? { contact_tags: { some: { tag_id: { in: criteria.tag_ids } } } }
          : {}),
      },
      select: { phone: true, email: true },
      take: 50_000,
    });

    const phones = contacts
      .map((c) => c.phone)
      .filter((p): p is string => Boolean(p));

    if (adsSandbox()) {
      await this.prisma.meta_ad_audiences.update({
        where: { id: audience.id },
        data: { approximate_count: phones.length, last_synced_at: new Date() },
      });
      return { uploaded: phones.length, skipped: 0 };
    }

    const connection = await this.config.requireAdAccount(args.accountId);

    const uploads: Array<{
      field: AudienceSchemaField;
      identifiers: string[];
    }> = [{ field: 'PHONE', identifiers: phones }];

    if (criteria.include_emails) {
      const emails = contacts
        .map((c) => c.email)
        .filter((e): e is string => Boolean(e));
      if (emails.length) uploads.push({ field: 'EMAIL', identifiers: emails });
    }

    let received = 0;
    let skipped = 0;
    for (const upload of uploads) {
      const batch = await addUsersToAudience({
        accessToken: connection.accessToken,
        audienceId: args.audienceId,
        field: upload.field,
        identifiers: upload.identifiers,
      });
      received += batch.received;
      skipped += batch.skipped;
    }

    await this.prisma.meta_ad_audiences.update({
      where: { id: audience.id },
      data: { approximate_count: phones.length, last_synced_at: new Date() },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'refresh_audience',
      objectType: 'audience',
      objectId: args.audienceId,
      detail: { uploaded: received, skipped },
    });

    return { uploaded: received, skipped };
  }

  async createLookalike(args: {
    accountId: string;
    userId: string;
    name: string;
    sourceAudienceId: string;
    country: string;
    ratio: number;
  }): Promise<{ audienceId: string }> {
    // Scoped by account: the source audience must be one of ours, or a
    // caller could seed a lookalike from another tenant's list.
    const source = await this.prisma.meta_ad_audiences.findFirst({
      where: {
        account_id: args.accountId,
        meta_audience_id: args.sourceAudienceId,
      },
      select: { id: true, name: true },
    });

    if (!source) {
      throw new NotFoundException(
        'That source audience is not available on this ad account.',
      );
    }

    if (adsSandbox()) {
      const id = `${SANDBOX_PREFIX}lal_${Date.now().toString(36)}`;
      await this.prisma.meta_ad_audiences.create({
        data: {
          account_id: args.accountId,
          meta_audience_id: id,
          name: args.name,
          subtype: 'LOOKALIKE',
          origin: 'crm',
          source_audience_id: args.sourceAudienceId,
          last_synced_at: new Date(),
        },
      });
      return { audienceId: id };
    }

    const connection = await this.config.requireAdAccount(args.accountId);

    const created = await createLookalikeAudience({
      accessToken: connection.accessToken,
      adAccountId: connection.adAccountId,
      name: args.name,
      sourceAudienceId: args.sourceAudienceId,
      country: args.country,
      ratio: args.ratio,
    });

    await this.prisma.meta_ad_audiences.create({
      data: {
        account_id: args.accountId,
        meta_audience_id: created.id,
        name: args.name,
        subtype: 'LOOKALIKE',
        origin: 'crm',
        source_audience_id: args.sourceAudienceId,
        last_synced_at: new Date(),
      },
    });

    await this.config.audit({
      accountId: args.accountId,
      userId: args.userId,
      action: 'create_lookalike',
      objectType: 'audience',
      objectId: created.id,
      detail: { source: args.sourceAudienceId, ratio: args.ratio },
    });

    return { audienceId: created.id };
  }

  private async recordCrmAudience(args: {
    accountId: string;
    audienceId: string;
    name: string;
    count: number;
    tagIds?: string[];
    includeEmails?: boolean;
  }): Promise<void> {
    await this.prisma.meta_ad_audiences.create({
      data: {
        account_id: args.accountId,
        meta_audience_id: args.audienceId,
        name: args.name,
        subtype: 'CUSTOM',
        // 'crm' rather than 'meta': this one has a local source and can be
        // rebuilt when the segment changes. A 'meta' audience cannot.
        origin: 'crm',
        approximate_count: args.count,
        // Stored so `refreshAudience` can rebuild the same segment later.
        // This is the whole reason the column exists.
        filter_criteria: toJson({
          tag_ids: args.tagIds ?? null,
          include_emails: Boolean(args.includeEmails),
        }),
        last_synced_at: new Date(),
      },
    });
  }

  // ============================================================

  /**
   * The page id plus a usable PAGE token.
   *
   * Lead forms live on the page, and using the user token gives a
   * permissions error naming neither the token nor the page — so the
   * absence is caught here with a sentence instead.
   */
  private async requirePage(
    accountId: string,
  ): Promise<{ pageId: string; pageAccessToken: string }> {
    const connection = await this.config.requireConnection(accountId);

    if (!connection.pageId) {
      throw new BadRequestException(
        'Select a Facebook page in Ads Manager → Setup first — lead forms belong to a page.',
      );
    }

    if (!connection.pageAccessToken) {
      throw new BadRequestException(
        'We do not hold a page access token for that page. Reconnect from Ads Manager → Setup to refresh it.',
      );
    }

    return {
      pageId: connection.pageId,
      pageAccessToken: connection.pageAccessToken,
    };
  }
}

/** Meta's subtype vocabulary is wider than our CHECK constraint allows. */
function normaliseSubtype(subtype: string | null): string {
  const allowed = ['CUSTOM', 'LOOKALIKE', 'WEBSITE', 'ENGAGEMENT', 'SAVED'];
  return subtype && allowed.includes(subtype) ? subtype : 'CUSTOM';
}
