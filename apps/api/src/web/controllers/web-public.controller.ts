import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import {
  WidgetKeyGuard,
  type RequestWithWidget,
} from '../guards/widget-key.guard';
import {
  VisitorSessionGuard,
  type RequestWithVisitor,
} from '../guards/visitor-session.guard';
import { WebConfigService } from '../services/web-config.service';
import { WebSessionService } from '../services/web-session.service';
import { WebInboundService } from '../services/web-inbound.service';
import { WebMediaService } from '../services/web-media.service';
import { WebStreamService } from '../services/web-stream.service';
import { PrismaService } from '../../prisma/prisma.service';
import { isOpenAt, parseBusinessHours } from '../utils/business-hours.util';
import { StartSessionDto } from '../dto/start-session.dto';
import { SendWebMessageDto } from '../dto/send-web-message.dto';
import { UploadWebMediaDto } from '../dto/upload-web-media.dto';
import { SubmitWidgetFormDto } from '../dto/submit-widget-form.dto';
import { FormsService } from '../../forms/services/forms.service';
import { FormSubmitService } from '../../forms/services/form-submit.service';
import type { PublicForm } from '../../forms/form.types';

/**
 * The visitor-facing surface. Anonymous browsers on customers' websites
 * call these.
 *
 * WHY THIS IS A SEPARATE CONTROLLER FROM web-config
 *   Not tidiness — blast radius. Dashboard routes carry
 *   `SupabaseAuthGuard`; every route here carries `WidgetKeyGuard` and
 *   most also `VisitorSessionGuard`. Mixing them in one class means one
 *   forgotten decorator silently exposes an account-scoped endpoint to the
 *   open internet, and nothing in review makes that obvious. Separate
 *   files means the guard set is a property of the file you are reading.
 *
 * EVERY ROUTE IS RATE-LIMITED ON (widget key, ip hash)
 *   These are the only endpoints in the app an unauthenticated stranger
 *   can reach in volume. Limiting per widget key alone would let one
 *   abusive visitor deny service to a customer's real ones; per IP alone
 *   would let a distributed script hammer one account. The pair bounds
 *   both.
 */
@Controller('public/web')
@UseGuards(WidgetKeyGuard)
export class WebPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WebConfigService,
    private readonly session: WebSessionService,
    private readonly inbound: WebInboundService,
    private readonly media: WebMediaService,
    private readonly stream: WebStreamService,
    private readonly rateLimit: RateLimitService,
    private readonly forms: FormsService,
    private readonly formSubmit: FormSubmitService,
  ) {}

  /**
   * Everything the widget needs to render before anyone says anything:
   * appearance, whether we are open, whether to offer live chat.
   *
   * Also the *only* signal that an installation is real, so it records
   * the sighting that promotes the channel to `connected`.
   */
  @Get('bootstrap')
  async bootstrap(@Req() request: RequestWithWidget) {
    const { accountId } = request.widget;
    await this.limit(request, 'bootstrap', 120);

    const status = await this.config.getOrCreate(
      accountId,
      request.widget.ownerUserId,
    );

    // Fire-and-forget: a failed status write must not stop the widget
    // rendering on the customer's page.
    void this.config.markSeen(accountId);

    const hours = parseBusinessHours(status.business_hours);
    const open = isOpenAt(hours, new Date());

    // The pre-chat and offline forms are inlined rather than referenced by
    // id. The widget needs both to render its very first screen, and a
    // reference would mean two extra round trips before a visitor sees
    // anything — on a channel where the whole point is that it opens
    // instantly. Only the offline one is conditional, because a closed
    // business is the only time it is reachable.
    const [prechatForm, offlineForm] = await Promise.all([
      this.publicFormById(accountId, status.prechat_form_id),
      open ? null : this.publicFormById(accountId, status.offline_form_id),
    ]);

    // Note what is NOT here: no widget_secret, no allowed_origins, no
    // account name, no counts. This payload is world-readable — anyone who
    // views source has the key that fetches it — so it carries only what
    // has to be rendered.
    return {
      appearance: status.appearance,
      locale: status.locale,
      show_branding: status.show_branding,
      ai_enabled: status.ai_enabled,
      is_open: open,
      /** Offer the offline path instead of live chat when closed. */
      offline: !open,
      /**
       * Shown before the chat starts. Null means "start chatting straight
       * away" — the widget falls back to its own built-in name/phone/email
       * screen only when the account has explicitly asked for pre-chat
       * capture without choosing a form.
       */
      prechat_form: prechatForm,
      offline_form: offlineForm,
    };
  }

  /**
   * A published form's public projection, by id.
   *
   * Resolved through `FormsService` so the same `mapping`/`default_value`
   * stripping applies as on the hosted page — the projection is the thing
   * that keeps a tenant's CRM structure out of a world-readable payload,
   * and re-implementing it here is how the two would drift.
   *
   * Returns null for a form that has been unpublished or deleted, so a
   * stale `prechat_form_id` degrades to "no pre-chat" rather than breaking
   * the widget on every page of the customer's site.
   */
  private async publicFormById(
    accountId: string,
    formId: string | null,
  ): Promise<PublicForm | null> {
    if (!formId) return null;
    const form = await this.forms.findPublicById(accountId, formId);
    return form?.form ?? null;
  }

  /**
   * One published form's public projection, for a card the visitor tapped.
   *
   * Only gated on the widget key, not on a session: a form card can arrive
   * before the visitor has done anything session-worthy, and the projection
   * carries nothing account-specific — the same content the hosted page
   * serves anonymously at `/f/<slug>`. Submitting it is what requires a
   * session.
   */
  @Get('forms/:id')
  async publicForm(
    @Req() request: RequestWithWidget,
    @Param('id') formId: string,
  ): Promise<PublicForm> {
    await this.limit(request, 'form-render', 60);
    const form = await this.forms.findPublicById(
      request.widget.accountId,
      formId,
    );
    if (!form) throw new NotFoundException('That form is no longer available.');
    return form.form;
  }

  /**
   * Submit a form from inside the chat — pre-chat capture, an offline
   * message, or a form card an automation sent.
   *
   * SEPARATE FROM `POST /public/forms/:slug/submit` FOR ONE REASON
   *   That endpoint deliberately refuses to accept a contact or
   *   conversation id, because it is unauthenticated and those would be
   *   attacker-chosen (see its docs). This endpoint can attach the
   *   submission to a live thread precisely because `VisitorSessionGuard`
   *   has proved, by signature, which conversation belongs to this caller.
   *   The ids come from the verified token, never from the body.
   */
  @Post('forms/:id/submit')
  @UseGuards(VisitorSessionGuard)
  async submitForm(
    @Req() request: RequestWithVisitor,
    @Param('id') formId: string,
    @Body() body: SubmitWidgetFormDto,
  ) {
    await this.limit(request, 'form-submit', 20);

    const form = await this.forms.findPublicById(
      request.visitor.accountId,
      formId,
    );
    if (!form) throw new NotFoundException('That form is no longer available.');

    return this.formSubmit.submit({
      accountId: request.visitor.accountId,
      ownerUserId: request.widget.ownerUserId,
      formId: form.form.id,
      fields: form.rawFields,
      settings: form.settings,
      answers: body.answers ?? {},
      source: 'widget',
      // From the token, not the body. This is the whole reason the endpoint
      // exists.
      contactId: request.visitor.contactId,
      conversationId: request.visitor.conversationId,
      meta: {
        pageUrl: body.page_url,
        userAgent: request.headers['user-agent'],
        ip: clientIp(request),
      },
      spam: body.spam,
    });
  }

  /**
   * Start a chat, or resume the one this browser already had.
   *
   * Deliberately NOT called on page load — only when the visitor actually
   * opens the widget. Creating a contact and a conversation for every
   * pageview would fill the CRM with rows for people who never engaged.
   */
  @Post('session')
  async startSession(
    @Req() request: RequestWithWidget,
    @Body() body: StartSessionDto,
  ) {
    await this.limit(request, 'session', 30);

    const result = await this.session.startOrResume({
      accountId: request.widget.accountId,
      ownerUserId: request.widget.ownerUserId,
      existingToken: body.session_token,
      pageUrl: body.page_url,
      referrer: body.referrer,
      utm: body.utm,
      userAgent: request.headers['user-agent'],
      ip: clientIp(request),
      identity: body.identity,
      profile: body.profile,
    });

    const history = await this.history(
      request.widget.accountId,
      result.conversationId,
    );

    return {
      session_token: result.sessionToken,
      conversation_id: result.conversationId,
      is_new: result.isNew,
      messages: history,
      agent_typing: await this.stream.isAgentTyping(result.conversationId),
    };
  }

  /** The thread, oldest first. Called on resume and after a reconnect. */
  @Get('messages')
  @UseGuards(VisitorSessionGuard)
  async messages(@Req() request: RequestWithVisitor) {
    await this.limit(request, 'messages', 120);

    const contact = await this.prisma.contacts.findUnique({
      where: { id: request.visitor.contactId },
      select: { name: true, phone: true },
    });
    if (!contact?.name?.trim() || !contact?.phone?.trim()) {
      throw new UnauthorizedException('Contact name and phone required.');
    }

    return {
      messages: await this.history(
        request.visitor.accountId,
        request.visitor.conversationId,
      ),
    };
  }

  @Post('messages')
  @UseGuards(VisitorSessionGuard)
  async send(
    @Req() request: RequestWithVisitor,
    @Body() body: SendWebMessageDto,
  ) {
    await this.limit(request, 'send', 60);

    const hasText = Boolean(body.text?.trim());
    const hasMedia = Boolean(body.media_url);
    if (!hasText && !hasMedia && !body.reply_id) {
      throw new BadRequestException(
        'A message needs text, a file or a choice.',
      );
    }

    const result = await this.inbound.handle({
      accountId: request.visitor.accountId,
      ownerUserId: request.widget.ownerUserId,
      conversationId: request.visitor.conversationId,
      contactId: request.visitor.contactId,
      contentType: body.content_type ?? 'text',
      text: body.text ?? '',
      mediaUrl: body.media_url,
      interactiveReplyId: body.reply_id,
      pageUrl: body.page_url,
    });

    return { id: result.messageId, created_at: result.createdAt };
  }

  /**
   * Visitor is typing. Fire-and-forget from the client's perspective —
   * a lost ping just means the agent misses one indicator.
   *
   * The tightest limit on this controller because it fires on keystrokes:
   * the widget debounces, but the server cannot assume it did.
   */
  @Post('typing')
  @UseGuards(VisitorSessionGuard)
  async typing(@Req() request: RequestWithVisitor) {
    await this.limit(request, 'typing', 240);
    await this.stream.publish(request.visitor.conversationId, {
      type: 'typing',
      from: 'agent',
      at: new Date().toISOString(),
    });
    return { ok: true };
  }

  @Post('read')
  @UseGuards(VisitorSessionGuard)
  async read(@Req() request: RequestWithVisitor) {
    await this.limit(request, 'read', 120);
    await this.inbound.markRead(
      request.visitor.accountId,
      request.visitor.conversationId,
    );
    return { ok: true };
  }

  /**
   * Attachment upload. Base64 in a JSON body rather than multipart: the
   * widget is a small hand-written bundle with no form-data helper, the
   * 20 MB cap keeps the ~33% base64 overhead bounded, and it avoids adding
   * a multipart parser to a public endpoint.
   */
  @Post('upload')
  @UseGuards(VisitorSessionGuard)
  async upload(
    @Req() request: RequestWithVisitor,
    @Body() body: UploadWebMediaDto,
  ) {
    await this.limit(request, 'upload', 20);

    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.data_base64, 'base64');
    } catch {
      throw new BadRequestException('That file could not be read.');
    }

    const result = await this.media.upload({
      accountId: request.visitor.accountId,
      conversationId: request.visitor.conversationId,
      filename: body.filename,
      contentType: body.content_type,
      bytes,
    });

    return { url: result.url, kind: result.kind };
  }

  // ----------------------------------------------------------------

  /**
   * The thread as the visitor may see it.
   *
   * `sender_id` is projected away on purpose: which internal user replied
   * is not the visitor's business, and `agent` is all the widget renders.
   * Tombstoned rows are excluded via the partial index from migration 050.
   */
  private async history(accountId: string, conversationId: string) {
    const rows = await this.prisma.messages.findMany({
      where: {
        conversation_id: conversationId,
        conversations: { account_id: accountId, channel: 'web' },
        deleted_at: null,
      },
      orderBy: { created_at: 'asc' },
      // Enough to be a conversation, bounded so a long-running thread
      // cannot turn one request into a multi-megabyte response.
      take: 200,
      select: {
        id: true,
        sender_type: true,
        content_type: true,
        content_text: true,
        media_url: true,
        interactive_reply_id: true,
        metadata: true,
        status: true,
        created_at: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      sender_type: row.sender_type,
      content_type: row.content_type,
      content_text: row.content_text,
      media_url: row.media_url,
      interactive_reply_id: row.interactive_reply_id,
      metadata: row.metadata,
      status: row.status,
      created_at: (row.created_at ?? new Date()).toISOString(),
    }));
  }

  private async limit(
    request: RequestWithWidget,
    bucket: string,
    perMinute: number,
  ): Promise<void> {
    const key = `web:${bucket}:${request.widget.widgetKey}:${clientIp(request) ?? 'unknown'}`;
    const result = await this.rateLimit.check(key, {
      limit: perMinute,
      windowMs: 60_000,
    });
    if (!result.success) {
      throw new BadRequestException(
        'Too many requests — please slow down and try again shortly.',
      );
    }
  }
}

/**
 * The visitor's IP as seen through whatever proxies sit in front of us.
 *
 * `x-forwarded-for` is a client-settable header and therefore NOT
 * trustworthy as identity. It is used here only for rate-limit bucketing
 * and a salted hash — where a spoofed value costs the spoofer their own
 * bucket and nothing else. It must never be used for authorisation.
 */
function clientIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(',')[0].trim();
  }
  return request.ip ?? request.socket?.remoteAddress ?? undefined;
}
