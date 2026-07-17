import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as express from 'express';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service.js';

@Controller('integrations/facebook')
export class FacebookController {
  private readonly logger = new Logger(FacebookController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /api/integrations/facebook/connect
   * OAuth + long-lived token exchange + Pages fetch.
   * Preserves the `isDemo` sandbox path.
   */
  @UseGuards(SupabaseAuthGuard)
  @Post('connect')
  async connect(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { accessToken?: string; isDemo?: boolean },
    @Res() res: express.Response,
  ) {
    const { accessToken, isDemo } = body;

    if (!accessToken) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Access token is required' });
    }

    if (isDemo || accessToken === 'mock_demo_user_token') {
      // Sandbox mock connection
      const conn = await this.prisma.facebook_connections.upsert({
        where: {
          user_id_fb_user_id: {
            user_id: account.userId,
            fb_user_id: 'demo_12345678',
          },
        },
        create: {
          user_id: account.userId,
          fb_user_id: 'demo_12345678',
          fb_user_name: 'Jane Demo (Sandbox)',
          access_token: 'mock_long_lived_demo_token',
        },
        update: {
          fb_user_name: 'Jane Demo (Sandbox)',
          access_token: 'mock_long_lived_demo_token',
        },
      });

      for (const mock of [
        { id: 'page_mock_1', name: 'Acme Corp Leads Sandbox', token: 'mock_page_token_1' },
        { id: 'page_mock_2', name: 'Instagram Growth Sandbox', token: 'mock_page_token_2' },
      ]) {
        await this.prisma.facebook_pages.upsert({
          where: { user_id_page_id: { user_id: account.userId, page_id: mock.id } },
          create: {
            connection_id: conn.id,
            user_id: account.userId,
            page_id: mock.id,
            page_name: mock.name,
            page_access_token: mock.token,
            is_syncing: false,
          },
          update: { page_name: mock.name },
        });
      }

      return res.status(HttpStatus.OK).json({ success: true, isDemo: true });
    }

    // Real OAuth flow
    const appId = process.env.META_APP_ID ?? process.env.NEXT_PUBLIC_FACEBOOK_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: 'Meta Developer App credentials are not configured on the server.',
      });
    }

    // 1. Exchange short-lived token for 60-day long-lived token
    const tokenUrl = `https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${accessToken}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      error?: { message?: string };
    };

    if (!tokenRes.ok || tokenData.error) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: tokenData.error?.message ?? 'Failed to exchange long-lived access token',
      });
    }

    const longLivedToken = tokenData.access_token!;

    // 2. Fetch Facebook User ID + Name
    const meRes = await fetch(
      `https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${longLivedToken}`,
    );
    const meData = (await meRes.json()) as {
      id?: string;
      name?: string;
      error?: { message?: string };
    };

    if (!meRes.ok || meData.error) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: meData.error?.message ?? 'Failed to fetch user profile',
      });
    }

    // 3. Upsert connection
    const conn = await this.prisma.facebook_connections.upsert({
      where: {
        user_id_fb_user_id: {
          user_id: account.userId,
          fb_user_id: meData.id!,
        },
      },
      create: {
        user_id: account.userId,
        fb_user_id: meData.id!,
        fb_user_name: meData.name!,
        access_token: longLivedToken,
      },
      update: {
        fb_user_name: meData.name!,
        access_token: longLivedToken,
      },
    });

    // 4. Fetch Pages
    const pagesRes = await fetch(
      `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token&access_token=${longLivedToken}&limit=100`,
    );
    const pagesData = (await pagesRes.json()) as {
      data?: Array<{ id: string; name: string; access_token: string }>;
      error?: { message?: string };
    };

    if (!pagesRes.ok || pagesData.error) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: pagesData.error?.message ?? 'Failed to fetch Facebook pages',
      });
    }

    // 5. Upsert pages
    for (const page of pagesData.data ?? []) {
      await this.prisma.facebook_pages.upsert({
        where: { user_id_page_id: { user_id: account.userId, page_id: page.id } },
        create: {
          connection_id: conn.id,
          user_id: account.userId,
          page_id: page.id,
          page_name: page.name,
          page_access_token: page.access_token,
          is_syncing: false,
        },
        update: { page_name: page.name, page_access_token: page.access_token },
      });
    }

    return res.status(HttpStatus.OK).json({ success: true });
  }

  /**
   * POST /api/integrations/facebook/pages
   * Toggle lead-sync subscription for a Page.
   */
  @UseGuards(SupabaseAuthGuard)
  @Post('pages')
  async togglePageSync(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { pageId?: string; isSyncing?: boolean },
    @Res() res: express.Response,
  ) {
    const { pageId, isSyncing } = body;

    if (!pageId) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Page ID is required' });
    }

    const page = await this.prisma.facebook_pages.findFirst({
      where: { user_id: account.userId, page_id: pageId },
    });

    if (!page) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Page not found or access denied' });
    }

    const isMock = pageId.startsWith('page_mock');
    if (!isMock) {
      const method = isSyncing ? 'POST' : 'DELETE';
      const params = new URLSearchParams({
        subscribed_fields: 'leads',
        access_token: page.page_access_token,
      });

      const subRes = await fetch(
        `https://graph.facebook.com/v20.0/${pageId}/subscribed_apps?${params.toString()}`,
        { method },
      );
      const subData = (await subRes.json()) as { error?: { message?: string } };

      if (!subRes.ok || subData.error) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          error:
            subData.error?.message ??
            `Failed to ${isSyncing ? 'subscribe' : 'unsubscribe'} webhook on Meta Page`,
        });
      }
    }

    await this.prisma.facebook_pages.update({
      where: { id: page.id },
      data: { is_syncing: Boolean(isSyncing) },
    });

    return res.status(HttpStatus.OK).json({ success: true, isSyncing });
  }
}

// ---------------------------------------------------------------------------
// Facebook Lead Ads Webhook — separate controller so it gets no auth guard
// ---------------------------------------------------------------------------

@Controller('webhooks/facebook-leads')
export class FacebookLeadsWebhookController {
  private readonly logger = new Logger(FacebookLeadsWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliver: WebhookDeliverService,
  ) {}

  /**
   * GET /api/webhooks/facebook-leads — Meta challenge verification.
   */
  @Get()
  verifyChallenge(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: express.Response,
  ) {
    const expected =
      process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN ?? 'wacrm-fb-leads-verify';

    if (mode === 'subscribe' && verifyToken === expected) {
      this.logger.log('Facebook Leads Webhook verified');
      return res.status(200).send(challenge);
    }

    this.logger.warn('Facebook Leads Webhook verification failed');
    return res.status(403).send('Verification failed');
  }

  /**
   * POST /api/webhooks/facebook-leads — real-time lead notification.
   * SECURITY FIX: verifies `X-Hub-Signature-256` HMAC (was missing in legacy).
   */
  @Post()
  async handleLeadEvent(
    @Req() req: RawBodyRequest<express.Request>,
    @Res() res: express.Response,
  ) {
    // Verify X-Hub-Signature-256 (HMAC-SHA256 of raw body with app secret)
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const appSecret = process.env.META_APP_SECRET ?? '';

    if (appSecret && signature) {
      const rawBody = req.rawBody ?? Buffer.from('');
      const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      const valid =
        sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);

      if (!valid) {
        this.logger.warn('Facebook lead webhook: invalid HMAC signature');
        return res.status(403).json({ error: 'Invalid signature' });
      }
    } else if (appSecret) {
      // App secret configured but no signature sent — reject
      this.logger.warn('Facebook lead webhook: missing X-Hub-Signature-256');
      return res.status(403).json({ error: 'Missing signature' });
    }

    const body = req.body as {
      object?: string;
      entry?: Array<{
        changes?: Array<{
          field?: string;
          value?: { leadgen_id?: string; page_id?: string };
        }>;
      }>;
    };

    if (body.object !== 'page') {
      return res.status(200).json({ success: true, ignored: 'not page object' });
    }

    // Process leads fire-and-forget
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'leadgen') {
          const { leadgen_id, page_id } = change.value ?? {};
          if (leadgen_id && page_id) {
            void this.processLead(leadgen_id, page_id).catch((err: unknown) => {
              this.logger.error(`processLead error for ${leadgen_id}`, err);
            });
          }
        }
      }
    }

    return res.status(200).json({ success: true });
  }

  private async processLead(leadgenId: string, pageId: string): Promise<void> {
    const page = await this.prisma.facebook_pages.findFirst({
      where: { page_id: pageId },
      select: { user_id: true, page_access_token: true, is_syncing: true },
    });

    if (!page?.is_syncing) return;

    // Resolve tenant account_id
    const profile = await this.prisma.profile.findFirst({
      where: { userId: page.user_id },
      select: { accountId: true },
    });

    if (!profile) {
      this.logger.warn(`No Profile/Account found for Facebook Page user: ${page.user_id}`);
      return;
    }

    const accountId = profile.accountId;

    let name = '';
    let email = '';
    let phone = '';
    let company = '';

    const isMock = pageId.startsWith('page_mock');
    if (isMock) {
      name = 'Test Lead Ads User';
      email = 'test.lead@example.com';
      phone = '+919999988888';
      company = 'Meta Sandbox LLC';
    } else {
      const leadRes = await fetch(
        `https://graph.facebook.com/v20.0/${leadgenId}?access_token=${page.page_access_token}`,
      );
      const leadData = (await leadRes.json()) as {
        field_data?: Array<{ name: string; values?: string[] }>;
        error?: unknown;
      };

      if (!leadRes.ok || leadData.error) {
        this.logger.error(`Meta Graph API error for lead ${leadgenId}`, leadData.error);
        return;
      }

      for (const field of leadData.field_data ?? []) {
        const val = field.values?.[0] ?? '';
        if (field.name === 'full_name' || field.name === 'name') name = val;
        else if (field.name === 'email') email = val;
        else if (field.name === 'phone_number' || field.name === 'phone') phone = val;
        else if (field.name === 'company' || field.name === 'company_name') company = val;
      }
    }

    const cleanPhone = (phone || '+0000000000').replace(/[^\d+]/g, '');

    // Upsert contact
    let contact = await this.prisma.contacts.findFirst({
      where: { account_id: accountId, phone: cleanPhone },
    });

    if (!contact) {
      contact = await this.prisma.contacts.create({
        data: {
          account_id: accountId,
          user_id: page.user_id,
          phone: cleanPhone,
          name: name || 'Facebook Lead',
          email: email || null,
          company: company || null,
        },
      });
      this.logger.log(`Created contact ${contact.id} from FB lead ${leadgenId}`);

      await this.webhookDeliver.dispatchWebhookEvent(accountId, 'contact.created', {
        contact_id: contact.id,
        phone: cleanPhone,
        name: contact.name,
      });
    } else {
      const updates: Record<string, unknown> = {};
      if (!contact.name && name) updates.name = name;
      if (!contact.email && email) updates.email = email;
      if (Object.keys(updates).length > 0) {
        await this.prisma.contacts.update({ where: { id: contact.id }, data: updates });
      }
    }

    // Create pipeline deal in first stage of first pipeline
    const pipeline = await this.prisma.pipelines.findFirst({
      where: { account_id: accountId },
      select: { id: true },
    });

    if (pipeline) {
      const stage = await this.prisma.pipeline_stages.findFirst({
        where: { pipeline_id: pipeline.id },
        orderBy: { position: 'asc' },
        select: { id: true },
      });

      if (stage) {
        await this.prisma.deals.create({
          data: {
            account_id: accountId,
            user_id: page.user_id,
            pipeline_id: pipeline.id,
            stage_id: stage.id,
            contact_id: contact.id,
            title: `${contact.name || 'Facebook Lead'} - Lead Ads`,
            value: 0,
            currency: 'INR',
            status: 'active',
          },
        });
        this.logger.log(`Created pipeline deal for contact ${contact.id}`);
      }
    }

    // Create conversation + message
    const lastMessage = `New Facebook Lead: ${contact.name}`;

    let conversation = await this.prisma.conversations.findFirst({
      where: { account_id: accountId, contact_id: contact.id },
    });

    if (!conversation) {
      conversation = await this.prisma.conversations.create({
        data: {
          account_id: accountId,
          user_id: page.user_id,
          contact_id: contact.id,
          status: 'open',
          last_message_text: lastMessage,
          last_message_at: new Date(),
          unread_count: 1,
        },
      });
    } else {
      await this.prisma.conversations.update({
        where: { id: conversation.id },
        data: {
          last_message_text: lastMessage,
          last_message_at: new Date(),
          unread_count: { increment: 1 },
          status: 'open',
        },
      });
    }

    await this.prisma.messages.create({
      data: {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: `[Facebook Lead Capture] Email: ${email || 'N/A'}, Phone: ${phone || 'N/A'}, Company: ${company || 'N/A'}`,
        status: 'delivered',
      },
    });
  }
}
