import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import {
  ADS_REQUIRED_SCOPES,
  adsMaxDailyBudgetMinor,
  adsSandbox,
} from '../ads.config';

/**
 * The connected ad account, resolved and decrypted.
 *
 * THIS IS THE ONLY PLACE A CLIENT-SUPPLIED AD ACCOUNT ID WOULD EVER
 * HAVE ENTERED, AND IT DOES NOT.
 *   Every id below comes from `meta_ads_config` keyed by the caller's
 *   own `accountId`. No route accepts an `ad_account_id`, `page_id`,
 *   `audience_id` or `form_id` from a request body, because Prisma
 *   connects as the database owner and bypasses RLS — the guard rails
 *   that stop tenant A reading tenant B's rows in the browser do not
 *   exist here. Two cross-tenant leaks with exactly this shape have
 *   already shipped and been removed from this repo (the deleted
 *   `subscription/admin/users` endpoint and its `targetUserId` writes).
 *
 *   On this surface the consequence is worse than a data leak: an
 *   attacker-supplied ad account id is an instruction to spend someone
 *   else's money.
 */
export interface AdsConnection {
  id: string;
  accountId: string;
  userId: string;
  /** Decrypted. Never log, never return to a client. */
  accessToken: string;
  fbUserId: string;
  fbUserName: string | null;
  grantedScopes: string[];
  tokenExpiresAt: Date | null;

  businessId: string | null;
  businessName: string | null;
  /** Bare id, no `act_` prefix. */
  adAccountId: string | null;
  adAccountName: string | null;
  currency: string | null;
  timezoneName: string | null;
  accountStatus: number | null;
  fundingOk: boolean;

  pageId: string | null;
  pageName: string | null;
  /** Decrypted, when we hold one. */
  pageAccessToken: string | null;

  whatsappPhoneNumberId: string | null;
  whatsappDisplayNumber: string | null;

  pixelId: string | null;
  pixelName: string | null;

  leadTermsAcceptedAt: Date | null;
  status: string;
}

/** One row of the Setup checklist (screenshot 1's stepper). */
export interface AdsSetupStep {
  id: string;
  label: string;
  done: boolean;
  /** Why this step cannot be completed yet, when it can't. */
  blocked: string | null;
}

export interface AdsSetupStatus {
  sandbox: boolean;
  connected: boolean;
  status: string;
  fbUserName: string | null;
  /** Permissions we asked for and Meta did not grant. */
  missingScopes: string[];
  tokenExpiresAt: string | null;
  business: { id: string; name: string | null } | null;
  adAccount: {
    id: string;
    name: string | null;
    currency: string | null;
    timezoneName: string | null;
    accountStatus: number | null;
    fundingOk: boolean;
  } | null;
  page: { id: string; name: string | null } | null;
  whatsapp: { phoneNumberId: string; displayNumber: string | null } | null;
  pixel: { id: string; name: string | null } | null;
  leadTermsAcceptedAt: string | null;
  steps: AdsSetupStep[];
  /** True only when every hard requirement for publishing is satisfied. */
  canPublish: boolean;
  /** Server-side budget ceiling, echoed so the wizard validates the same number. */
  maxDailyBudgetMinor: number;
}

/**
 * Reads and writes the one `meta_ads_config` row per workspace, and is
 * the single place that decrypts an ads token.
 *
 * Everything else in the module asks this service for a connection
 * rather than querying Prisma itself, so the account scoping and the
 * decryption both live in one auditable place.
 */
@Injectable()
export class AdsConfigService {
  private readonly logger = new Logger(AdsConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The connection for this workspace, or null.
   *
   * A token that fails to decrypt is treated as no connection rather
   * than crashing the request: that is what a rotated `ENCRYPTION_KEY`
   * looks like, and the fix is to reconnect, which requires the page to
   * render.
   */
  async findConnection(accountId: string): Promise<AdsConnection | null> {
    const row = await this.prisma.meta_ads_config.findUnique({
      where: { account_id: accountId },
    });
    if (!row) return null;

    let accessToken: string;
    try {
      accessToken = decrypt(row.access_token);
    } catch {
      this.logger.warn(
        `meta_ads_config for account ${accountId} could not be decrypted — ` +
          'treating as disconnected. ENCRYPTION_KEY may have been rotated; the account must reconnect.',
      );
      return null;
    }

    let pageAccessToken: string | null = null;
    if (row.page_access_token) {
      try {
        pageAccessToken = decrypt(row.page_access_token);
      } catch {
        // A dead page token degrades lead-form management but not the
        // rest of the surface, so it does not invalidate the connection.
        this.logger.warn(
          `Page token for account ${accountId} could not be decrypted.`,
        );
      }
    }

    return {
      id: row.id,
      accountId: row.account_id,
      userId: row.user_id,
      accessToken,
      fbUserId: row.fb_user_id,
      fbUserName: row.fb_user_name,
      grantedScopes: row.granted_scopes,
      tokenExpiresAt: row.token_expires_at,
      businessId: row.business_id,
      businessName: row.business_name,
      adAccountId: row.ad_account_id,
      adAccountName: row.ad_account_name,
      currency: row.currency,
      timezoneName: row.timezone_name,
      accountStatus: row.account_status,
      fundingOk: row.funding_ok,
      pageId: row.page_id,
      pageName: row.page_name,
      pageAccessToken,
      whatsappPhoneNumberId: row.whatsapp_phone_number_id,
      whatsappDisplayNumber: row.whatsapp_display_number,
      pixelId: row.pixel_id,
      pixelName: row.pixel_name,
      leadTermsAcceptedAt: row.lead_terms_accepted_at,
      status: row.status,
    };
  }

  /** As `findConnection`, but 400s with an actionable message instead of null. */
  async requireConnection(accountId: string): Promise<AdsConnection> {
    const connection = await this.findConnection(accountId);
    if (!connection) {
      throw new BadRequestException(
        'No Meta ad account is connected. Connect one from Ads Manager → Setup.',
      );
    }
    return connection;
  }

  /**
   * A connection plus a guaranteed ad account id.
   *
   * Separate from `requireConnection` because "signed in to Facebook"
   * and "has chosen an ad account" are different states, and every
   * Marketing API path needs the second one. Returning a narrowed type
   * means the call sites cannot forget the null check.
   */
  async requireAdAccount(
    accountId: string,
  ): Promise<AdsConnection & { adAccountId: string }> {
    const connection = await this.requireConnection(accountId);
    if (!connection.adAccountId) {
      throw new BadRequestException(
        'No ad account has been selected yet. Finish Ads Manager → Setup.',
      );
    }
    return { ...connection, adAccountId: connection.adAccountId };
  }

  /** Scopes we need that Meta did not grant. */
  missingScopes(connection: AdsConnection | null): string[] {
    if (!connection) return [...ADS_REQUIRED_SCOPES];
    const granted = new Set(connection.grantedScopes);
    return ADS_REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  }

  /**
   * The Setup checklist, derived server-side.
   *
   * Derived here rather than in the web app so the "can this account
   * publish?" answer has exactly one implementation. The wizard's
   * Publish button and the API's publish guard must never disagree —
   * a UI that lets you press Publish on an unpublishable account is how
   * you get a support ticket instead of a validation message.
   */
  async getStatus(accountId: string): Promise<AdsSetupStatus> {
    const connection = await this.findConnection(accountId);
    const missing = this.missingScopes(connection);

    // Resolved rather than typed by the user: the CTWA destination is
    // whatever WhatsApp number this workspace already has connected.
    const whatsapp = connection
      ? await this.prisma.whatsapp_config.findUnique({
          where: { account_id: accountId },
          select: { phone_number_id: true, status: true },
        })
      : null;

    const steps: AdsSetupStep[] = [
      {
        id: 'connect',
        label: 'Connect your Facebook account',
        done: Boolean(connection),
        blocked: null,
      },
      {
        id: 'scopes',
        label: 'Grant advertising permissions',
        done: Boolean(connection) && missing.length === 0,
        blocked:
          connection && missing.length > 0
            ? `Reconnect and allow: ${missing.join(', ')}. Meta lets you decline individual permissions, and these are required.`
            : null,
      },
      {
        id: 'ad-account',
        label: 'Select your ad account',
        done: Boolean(connection?.adAccountId),
        blocked: null,
      },
      {
        id: 'funding',
        label: 'Ad account can run ads',
        done: Boolean(connection?.adAccountId && connection.fundingOk),
        blocked:
          connection?.adAccountId && !connection.fundingOk
            ? 'This ad account has no usable payment method, or is not active. Ads run on your own ad account and Meta bills you directly, so add a payment method in Meta Business Settings.'
            : null,
      },
      {
        id: 'page',
        label: 'Select your Facebook page',
        done: Boolean(connection?.pageId),
        blocked: null,
      },
      {
        id: 'whatsapp',
        label: 'Link your WhatsApp number',
        done: Boolean(connection?.whatsappPhoneNumberId),
        blocked:
          connection && !whatsapp
            ? 'Connect a WhatsApp number first (Channels → WhatsApp). Click-to-WhatsApp ads need somewhere to deliver the conversation.'
            : null,
      },
    ];

    // Publishing needs the connection, the permissions, an ad account
    // that can actually spend, and a page to run the ad from. A
    // WhatsApp number is required only by the two WhatsApp ad types, so
    // it is a checklist row rather than a hard gate here — the per-type
    // builders enforce their own needs.
    const canPublish = Boolean(
      connection &&
      missing.length === 0 &&
      connection.adAccountId &&
      connection.fundingOk &&
      connection.pageId,
    );

    return {
      sandbox: adsSandbox(),
      connected: Boolean(connection),
      status: connection?.status ?? 'disconnected',
      fbUserName: connection?.fbUserName ?? null,
      missingScopes: missing,
      tokenExpiresAt: connection?.tokenExpiresAt?.toISOString() ?? null,
      business: connection?.businessId
        ? { id: connection.businessId, name: connection.businessName }
        : null,
      adAccount: connection?.adAccountId
        ? {
            id: connection.adAccountId,
            name: connection.adAccountName,
            currency: connection.currency,
            timezoneName: connection.timezoneName,
            accountStatus: connection.accountStatus,
            fundingOk: connection.fundingOk,
          }
        : null,
      page: connection?.pageId
        ? { id: connection.pageId, name: connection.pageName }
        : null,
      whatsapp: connection?.whatsappPhoneNumberId
        ? {
            phoneNumberId: connection.whatsappPhoneNumberId,
            displayNumber: connection.whatsappDisplayNumber,
          }
        : null,
      pixel: connection?.pixelId
        ? { id: connection.pixelId, name: connection.pixelName }
        : null,
      leadTermsAcceptedAt:
        connection?.leadTermsAcceptedAt?.toISOString() ?? null,
      steps,
      canPublish,
      maxDailyBudgetMinor: adsMaxDailyBudgetMinor(),
    };
  }

  /**
   * Recent audit entries for this workspace.
   *
   * `admin`-gated at the controller, matching the RLS on the table: this is
   * who spent money and who tried to. Failures are included — a rejected
   * publish attempt is exactly what an incident asks about.
   */
  async listAudit(
    accountId: string,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      action: string;
      objectType: string | null;
      objectId: string | null;
      succeeded: boolean;
      error: string | null;
      createdAt: string;
      actorName: string | null;
      detail: unknown;
    }>
  > {
    const rows = await this.prisma.meta_ads_audit.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });

    // Names resolved in one query rather than a join: `user_id` points at
    // `auth.users`, which is Supabase-managed, so the display name lives on
    // `profiles` instead.
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const profiles = userIds.length
      ? await this.prisma.profile.findMany({
          where: { userId: { in: userIds as string[] } },
          select: { userId: true, fullName: true, email: true },
        })
      : [];
    const nameByUser = new Map(
      profiles.map((p) => [p.userId, p.fullName ?? p.email ?? null]),
    );

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      objectType: row.object_type,
      objectId: row.object_id,
      succeeded: row.succeeded,
      error: row.error,
      createdAt: row.created_at.toISOString(),
      // Null for a system-initiated entry (Meta's deletion callback has no
      // user), which the UI shows as "system" rather than blank.
      actorName: row.user_id ? (nameByUser.get(row.user_id) ?? null) : null,
      detail: row.detail,
    }));
  }

  /**
   * Append to `meta_ads_audit`.
   *
   * Every write to Meta goes through here, INCLUDING failures — a
   * rejected publish attempt is exactly what you want to see when money
   * is involved. Never throws: an audit write that fails must not turn a
   * successful publish into an error the user sees, so it logs and
   * swallows.
   */
  async audit(args: {
    accountId: string;
    userId?: string | null;
    action: string;
    objectType?: string | null;
    objectId?: string | null;
    detail?: Record<string, unknown> | null;
    succeeded?: boolean;
    error?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.meta_ads_audit.create({
        data: {
          account_id: args.accountId,
          user_id: args.userId ?? null,
          action: args.action,
          object_type: args.objectType ?? null,
          object_id: args.objectId ?? null,
          detail: redactTokens(args.detail ?? null),
          succeeded: args.succeeded ?? true,
          error: args.error ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write ads audit entry (${args.action}) for account ${args.accountId}`,
        err,
      );
    }
  }
}

/**
 * Strip anything token-shaped out of an audit detail blob.
 *
 * The audit log records request payloads, and a payload that passed
 * through this module may carry an access token. An audit table is
 * exactly the kind of thing that gets exported into a spreadsheet
 * during an incident, so it must not be a token store.
 */
const TOKEN_KEY = /token|secret|password|authorization/i;

function redactTokens(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([k, v]) =>
          TOKEN_KEY.test(k) ? [k, '[redacted]'] : [k, walk(v)],
        ),
      );
    }
    return input;
  };
  // The walk preserves JSON-compatible shapes (the input is always a
  // plain object built at the call site), so the cast is narrowing a
  // structural truth the compiler cannot see through `unknown`.
  return walk(value) as Prisma.InputJsonValue;
}
