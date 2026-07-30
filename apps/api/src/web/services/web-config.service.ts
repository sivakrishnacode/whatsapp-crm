import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { encrypt, decrypt } from '../../common/security/encryption.util';
import {
  generateWidgetKey,
  generateWidgetSecret,
  normalizeOriginList,
} from '../utils/widget-key.util';

/**
 * What the dashboard sees. Deliberately has no `widget_secret` field at
 * all — not a redacted one — so there is no shape in which the secret
 * could accidentally be serialised into a response.
 */
export interface WebConnectionStatus {
  connected: boolean;
  status: 'disconnected' | 'connected' | 'disabled';
  widget_key: string;
  allowed_origins: string[];
  installed_at: string | null;
  last_seen_at: string | null;
  appearance: WidgetAppearance;
  business_hours: BusinessHours | null;
  ai_enabled: boolean;
  show_branding: boolean;
  locale: string;
  last_error: string | null;
  /**
   * Forms shown before the chat starts and outside business hours. Null
   * means "no form" — the widget falls back to its own built-in capture
   * screen for pre-chat, and lets the visitor message freely when offline.
   */
  prechat_form_id: string | null;
  offline_form_id: string | null;
  /** Everything needed to render the install snippet. */
  setup: {
    loader_url: string;
    snippet: string;
  };
}

export interface WidgetAppearance {
  accent: string;
  position: 'left' | 'right';
  theme: 'light' | 'dark' | 'auto';
  launcher_icon: string;
  title: string;
  subtitle: string;
  greeting: string | null;
  teaser: string | null;
  teaser_delay_seconds: number;
}

export interface BusinessHours {
  timezone: string;
  /** One entry per weekday, 0 = Sunday. Absent weekday = closed all day. */
  windows: Array<{ weekday: number; start: string; end: string }>;
}

export interface UpdateWebConfigInput {
  allowed_origins?: string[];
  appearance?: Partial<WidgetAppearance>;
  business_hours?: BusinessHours | null;
  ai_enabled?: boolean;
  show_branding?: boolean;
  locale?: string;
  status?: 'connected' | 'disabled';
  /**
   * `null` clears the form. Distinguished from `undefined` (leave alone)
   * because "no pre-chat form" is a real, choosable state.
   */
  prechat_form_id?: string | null;
  offline_form_id?: string | null;
}

/**
 * Mirrors `appearance`'s DB default. Duplicated in TypeScript so a row
 * written before a field existed still reads as complete rather than
 * handing `undefined` to the widget — the bootstrap payload has to be
 * total, because the widget has no fallback of its own.
 */
const DEFAULT_APPEARANCE: WidgetAppearance = {
  accent: '#2D7FF9',
  position: 'right',
  theme: 'auto',
  launcher_icon: 'chat',
  title: 'Chat with us',
  subtitle: 'We typically reply in a few minutes',
  greeting: null,
  teaser: null,
  teaser_delay_seconds: 8,
};

/**
 * The account's widget configuration.
 *
 * WHY THERE IS NO `connect()` HERE
 *   whatsapp_config and instagram_config are both created by completing
 *   an OAuth handshake with Meta. Web has no third party to authorise
 *   against: the config springs into existence the first time an admin
 *   opens the channel settings page, and "connected" is decided later,
 *   by observing a real bootstrap call from an allowed origin
 *   (`markSeen`). So the entry point is get-or-create, not connect.
 *
 * SECRET HANDLING
 *   `widget_secret` is encrypted at rest with the same
 *   encrypt()/decrypt() as whatsapp_config.access_token. Only
 *   `loadSigningSecret` decrypts it, so every future caller that needs
 *   to sign or verify goes through one place — the same containment the
 *   Instagram module gets from `loadUsableConfig`.
 */
@Injectable()
export class WebConfigService {
  private readonly logger = new Logger(WebConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The account's config, created on first read.
   *
   * Creating on read rather than making the user click "enable" is safe
   * because a fresh row is inert: `allowed_origins` is empty, and an
   * empty allowlist denies every request. Nothing is reachable until an
   * admin adds an origin.
   */
  async getOrCreate(
    accountId: string,
    userId: string,
  ): Promise<WebConnectionStatus> {
    const existing = await this.prisma.web_config.findUnique({
      where: { account_id: accountId },
    });
    if (existing) return this.toStatus(existing);

    const created = await this.prisma.web_config.create({
      data: {
        account_id: accountId,
        user_id: userId,
        widget_key: generateWidgetKey(),
        widget_secret: encrypt(generateWidgetSecret()),
      },
    });
    this.logger.log(`created web_config for account ${accountId}`);
    return this.toStatus(created);
  }

  async update(
    accountId: string,
    userId: string,
    input: UpdateWebConfigInput,
  ): Promise<WebConnectionStatus> {
    // Ensures a row exists before the update, so a first-ever save from
    // the settings page does not 404.
    await this.getOrCreate(accountId, userId);

    const data: Prisma.web_configUpdateInput = { updated_at: new Date() };

    if (input.allowed_origins !== undefined) {
      // Normalised on the way in, so `isOriginAllowed` compares like with
      // like and the settings UI can echo back exactly what will match
      // rather than what the user typed.
      data.allowed_origins = normalizeOriginList(input.allowed_origins);
    }

    if (input.appearance !== undefined) {
      // Merged over the current value, not replaced: the appearance
      // editor sends only the field the user touched, and a replace
      // would silently reset every other one to its default.
      const current = await this.prisma.web_config.findUniqueOrThrow({
        where: { account_id: accountId },
        select: { appearance: true },
      });
      data.appearance = {
        ...this.toAppearance(current.appearance),
        ...input.appearance,
      } as unknown as Prisma.InputJsonValue;
    }

    if (input.business_hours !== undefined) {
      data.business_hours =
        input.business_hours === null
          ? // Prisma needs DbNull rather than JS null to write SQL NULL
            // into a nullable Json column. `null` here would be the JSON
            // literal `null`, which reads back as "configured, empty"
            // instead of "always open".
            { set: null }
          : (input.business_hours as unknown as Prisma.InputJsonValue);
    }

    if (input.ai_enabled !== undefined) data.ai_enabled = input.ai_enabled;
    if (input.show_branding !== undefined) {
      data.show_branding = input.show_branding;
    }
    if (input.locale !== undefined) data.locale = input.locale;
    if (input.status !== undefined) data.status = input.status;

    // Relation fields, so `connect`/`disconnect` rather than a raw id —
    // and both directions are needed because clearing the form is a real
    // choice, not just "leave it alone".
    //
    // Each id is verified to belong to THIS account first. `connect` by id
    // is not tenant-scoped by itself, so without this an admin could point
    // their widget at another account's form. The bootstrap projection is
    // account-scoped and would refuse to serve it, so nothing would leak to
    // a visitor — but the foreign key would still be written, which is both
    // a confusing dangling reference and an existence oracle for another
    // tenant's form ids.
    if (input.prechat_form_id !== undefined) {
      data.prechat_form = input.prechat_form_id
        ? {
            connect: {
              id: await this.ownFormId(accountId, input.prechat_form_id),
            },
          }
        : { disconnect: true };
    }
    if (input.offline_form_id !== undefined) {
      data.offline_form = input.offline_form_id
        ? {
            connect: {
              id: await this.ownFormId(accountId, input.offline_form_id),
            },
          }
        : { disconnect: true };
    }

    const updated = await this.prisma.web_config.update({
      where: { account_id: accountId },
      data,
    });
    return this.toStatus(updated);
  }

  /**
   * Confirm a form id belongs to this account, or refuse.
   *
   * Returns the id so it can be used inline at the `connect` site, which
   * keeps the check impossible to forget: there is no way to write the
   * relation without going through here.
   */
  private async ownFormId(accountId: string, formId: string): Promise<string> {
    const form = await this.prisma.forms.findFirst({
      where: { id: formId, account_id: accountId },
      select: { id: true },
    });
    if (!form) {
      throw new NotFoundException('That form does not exist in this account.');
    }
    return form.id;
  }

  /**
   * Mint a new `widget_key`, invalidating every installed snippet.
   *
   * Destructive on purpose and separated from `update` so it can never
   * be triggered by a stray field in a settings payload: the widget
   * stops loading everywhere the moment this returns, until the customer
   * pastes the new snippet.
   */
  async rotateKey(accountId: string): Promise<WebConnectionStatus> {
    const updated = await this.prisma.web_config.update({
      where: { account_id: accountId },
      data: {
        widget_key: generateWidgetKey(),
        // Back to square one: the old snippet can no longer produce a
        // live load, so the previous "connected" is no longer a fact.
        status: 'disconnected',
        installed_at: null,
        updated_at: new Date(),
      },
    });
    this.logger.warn(`rotated widget_key for account ${accountId}`);
    return this.toStatus(updated);
  }

  /**
   * Mint a new `widget_secret`, invalidating every live visitor session.
   *
   * Separate from `rotateKey` because the blast radii differ: rotating
   * the key breaks the installation until the snippet is replaced;
   * rotating the secret drops open chats but leaves the snippet working.
   */
  async rotateSecret(accountId: string): Promise<WebConnectionStatus> {
    const updated = await this.prisma.web_config.update({
      where: { account_id: accountId },
      data: {
        widget_secret: encrypt(generateWidgetSecret()),
        updated_at: new Date(),
      },
    });
    this.logger.warn(`rotated widget_secret for account ${accountId}`);
    return this.toStatus(updated);
  }

  async disconnect(accountId: string): Promise<void> {
    // Soft: `disabled` stops the widget serving without discarding the
    // appearance, the allowlist or the account's chat history. Deleting
    // the row would orphan every `web` conversation's config context.
    await this.prisma.web_config.update({
      where: { account_id: accountId },
      data: { status: 'disabled', updated_at: new Date() },
    });
  }

  /**
   * Resolve a public widget key to its account. The routing read on
   * every widget load, so it selects only what the guard needs.
   *
   * Returns null for an unknown key rather than throwing — an unknown
   * key is an ordinary 403, not an error condition.
   */
  async findByWidgetKey(widgetKey: string): Promise<{
    accountId: string;
    userId: string;
    status: string;
    allowedOrigins: string[];
  } | null> {
    const config = await this.prisma.web_config.findUnique({
      where: { widget_key: widgetKey },
      select: {
        account_id: true,
        user_id: true,
        status: true,
        allowed_origins: true,
      },
    });
    if (!config) return null;
    return {
      accountId: config.account_id,
      userId: config.user_id,
      status: config.status,
      allowedOrigins: config.allowed_origins,
    };
  }

  /**
   * The decrypted signing secret. The ONLY place `widget_secret` is
   * decrypted — session-token signing and identity-verification HMACs
   * both come through here, so a future third caller cannot quietly
   * introduce a second decryption site.
   */
  async loadSigningSecret(accountId: string): Promise<string> {
    const config = await this.prisma.web_config.findUnique({
      where: { account_id: accountId },
      select: { widget_secret: true },
    });
    if (!config) {
      throw new NotFoundException('This account has no web widget configured.');
    }
    try {
      return decrypt(config.widget_secret);
    } catch {
      // Same failure mode as instagram-connect.service: almost always a
      // key mismatch between environments, not corruption. Say so.
      throw new Error(
        `Could not decrypt the widget secret for account ${accountId} — is ENCRYPTION_KEY correct for this environment?`,
      );
    }
  }

  /**
   * Record that the snippet is genuinely live.
   *
   * With no OAuth to complete, an observed bootstrap call from an allowed
   * origin is the only evidence that the widget is installed rather than
   * merely copied — so this is what promotes `disconnected` to
   * `connected`. `installed_at` is set once and never overwritten;
   * `last_seen_at` moves every call.
   */
  async markSeen(accountId: string): Promise<void> {
    const now = new Date();
    await this.prisma.web_config.updateMany({
      where: { account_id: accountId },
      data: { last_seen_at: now, status: 'connected' },
    });
    // Separate guarded write so a re-install does not rewrite the
    // original install date.
    await this.prisma.web_config.updateMany({
      where: { account_id: accountId, installed_at: null },
      data: { installed_at: now },
    });
  }

  // ----------------------------------------------------------------
  // Projections
  // ----------------------------------------------------------------

  private toAppearance(value: unknown): WidgetAppearance {
    if (!value || typeof value !== 'object') return DEFAULT_APPEARANCE;
    // Spread over the defaults rather than casting: a row written before
    // a field existed must read as complete, because the widget has no
    // fallback of its own.
    return { ...DEFAULT_APPEARANCE, ...(value as Partial<WidgetAppearance>) };
  }

  private toStatus(config: {
    status: string;
    widget_key: string;
    allowed_origins: string[];
    installed_at: Date | null;
    last_seen_at: Date | null;
    appearance: unknown;
    business_hours: unknown;
    ai_enabled: boolean;
    show_branding: boolean;
    locale: string;
    last_error: string | null;
    prechat_form_id: string | null;
    offline_form_id: string | null;
  }): WebConnectionStatus {
    const loaderUrl = `${this.publicBaseUrl()}/widget/v1/loader.js`;
    return {
      connected: config.status === 'connected',
      status: config.status as WebConnectionStatus['status'],
      widget_key: config.widget_key,
      allowed_origins: config.allowed_origins,
      installed_at: config.installed_at?.toISOString() ?? null,
      last_seen_at: config.last_seen_at?.toISOString() ?? null,
      appearance: this.toAppearance(config.appearance),
      business_hours: (config.business_hours as BusinessHours | null) ?? null,
      ai_enabled: config.ai_enabled,
      show_branding: config.show_branding,
      locale: config.locale,
      last_error: config.last_error,
      prechat_form_id: config.prechat_form_id,
      offline_form_id: config.offline_form_id,
      setup: {
        loader_url: loaderUrl,
        snippet: buildSnippet(loaderUrl, config.widget_key),
      },
    };
  }

  /**
   * Where the customer's browser should fetch the loader from — the
   * dashboard's own public origin, not the API's. Falls back to
   * localhost so the snippet is copy-pasteable in development.
   */
  private publicBaseUrl(): string {
    return (
      process.env.PUBLIC_APP_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000'
    );
  }
}

/**
 * The snippet the customer pastes. Built server-side so the dashboard
 * cannot drift from what the loader actually expects.
 *
 * `async` so it never blocks the host page's render — a chat widget that
 * slows down someone's storefront gets removed.
 */
export function buildSnippet(loaderUrl: string, widgetKey: string): string {
  return [
    '<script>',
    "  window.converse360Settings = { widgetKey: '" + widgetKey + "' };",
    '</script>',
    `<script async src="${loaderUrl}"></script>`,
  ].join('\n');
}
