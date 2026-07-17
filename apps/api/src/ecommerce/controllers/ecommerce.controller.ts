import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  Res,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopifyClient } from '../utils/shopify.client.js';
import { WooCommerceClient } from '../utils/woocommerce.client.js';

@Controller('ecommerce')
@UseGuards(SupabaseAuthGuard)
export class EcommerceController {
  private readonly logger = new Logger(EcommerceController.name);

  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/ecommerce/integrations — list connected stores. */
  @Get('integrations')
  async listIntegrations(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const integrations = await this.prisma.ecommerce_integrations.findMany({
      where: { account_id: account.accountId },
      orderBy: { created_at: 'desc' },
    });

    return res.status(HttpStatus.OK).json({ integrations });
  }

  /** POST /api/ecommerce/integrations — save store credentials. */
  @Post('integrations')
  async createIntegration(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: {
      platform?: unknown;
      store_url?: unknown;
      api_key?: unknown;
      api_secret?: unknown;
      access_token?: unknown;
    },
    @Res() res: Response,
  ) {
    const { platform, store_url } = body;

    if (!platform || !store_url) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'platform and store_url are required' });
    }

    if (!['shopify', 'woocommerce'].includes(platform as string)) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Invalid platform. Must be shopify or woocommerce',
      });
    }

    try {
      const integration = await this.prisma.ecommerce_integrations.create({
        data: {
          account_id: account.accountId,
          platform: platform as string,
          store_url: store_url as string,
          api_key: (body.api_key as string | null) ?? null,
          api_secret: (body.api_secret as string | null) ?? null,
          access_token: (body.access_token as string | null) ?? null,
          status: 'disconnected',
        },
      });

      return res.status(HttpStatus.CREATED).json({ integration });
    } catch (err: unknown) {
      const pg = err as { code?: string };
      if (pg.code === 'P2002') {
        // Unique constraint — duplicate platform for this account
        return res.status(HttpStatus.CONFLICT).json({
          error: `You already have a ${platform as string} integration. Please delete it first.`,
        });
      }
      throw err;
    }
  }

  /**
   * GET /api/ecommerce/shopify/callback — Shopify OAuth redirect handler.
   * Verifies HMAC, exchanges code for access token, updates integration row.
   * Note: this runs without auth guard since it's the OAuth redirect landing.
   */
  @Get('shopify/callback')
  async shopifyCallback(@Req() req: Request, @Res() res: Response) {
    const { code, state, shop, hmac } = req.query as Record<string, string>;

    if (!code || !state || !shop) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Missing required parameters' });
    }

    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET ?? '';
    const clientId = process.env.SHOPIFY_CLIENT_ID ?? '';

    // Verify HMAC: remove hmac param, sort remaining, compute SHA-256
    const params = new URLSearchParams(req.query as Record<string, string>);
    params.delete('hmac');
    const sortedParams = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const computed = createHmac('sha256', clientSecret)
      .update(sortedParams)
      .digest('hex');
    const hmacBuf = Buffer.from(hmac ?? '');
    const computedBuf = Buffer.from(computed);

    const valid =
      hmacBuf.length === computedBuf.length &&
      timingSafeEqual(hmacBuf, computedBuf);

    if (!valid) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Invalid HMAC' });
    }

    let stateData: { integrationId?: string };
    try {
      stateData = JSON.parse(
        Buffer.from(state, 'base64').toString(),
      ) as { integrationId?: string };
    } catch {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Invalid state' });
    }

    const { integrationId } = stateData;

    // Exchange code for access token
    let tokenData: { access_token?: string };
    try {
      const tokenRes = await fetch(
        `https://${shop}/admin/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
        },
      );
      tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenRes.ok) throw new Error('Token exchange failed');
    } catch (err) {
      this.logger.error('[Shopify OAuth] Token exchange error', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to connect to Shopify' });
    }

    await this.prisma.ecommerce_integrations.update({
      where: { id: integrationId },
      data: { access_token: tokenData.access_token, status: 'connected', sync_error: null },
    });

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    return res.redirect(`${baseUrl}/ecommerce`);
  }

  /** POST /api/ecommerce/sync/:id — pull products + orders from the store. */
  @Post('sync/:id')
  async syncIntegration(
    @Param('id') id: string,
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const integration = await this.prisma.ecommerce_integrations.findFirst({
      where: { id, account_id: account.accountId },
    });

    if (!integration) {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Integration not found' });
    }

    if (!integration.access_token && (!integration.api_key || !integration.api_secret)) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Integration not configured. Please complete OAuth or enter API credentials.',
      });
    }

    // Fire-and-forget sync; respond immediately
    void this.runSync(id, integration, account.userId).catch((err: unknown) => {
      this.logger.error('[ecommerce sync]', err);
    });

    return res.status(HttpStatus.ACCEPTED).json({ message: 'Sync started' });
  }

  private async runSync(
    id: string,
    integration: {
      id: string;
      account_id: string;
      platform: string;
      store_url: string;
      api_key: string | null;
      api_secret: string | null;
      access_token: string | null;
    },
    userId: string,
  ): Promise<void> {
    let productsSynced = 0;
    let ordersSynced = 0;

    try {
      if (integration.platform === 'shopify') {
        const client = new ShopifyClient(
          integration.store_url,
          integration.api_key ?? '',
          integration.api_secret ?? '',
          integration.access_token ?? undefined,
        );

        const products = await client.getProducts();

        for (const p of products) {
          await this.prisma.ecommerce_products.upsert({
            where: {
              integration_id_external_product_id: {
                integration_id: integration.id,
                external_product_id: p.id,
              },
            },
            create: {
              integration_id: integration.id,
              external_product_id: p.id,
              name: p.title,
              description: p.description ?? null,
              price: parseFloat(p.variants[0]?.price ?? '0'),
              currency: 'USD',
              image_url: p.images[0]?.url ?? null,
              product_url: `${integration.store_url}/products/${p.handle}`,
              inventory_count: p.variants[0]?.inventoryQuantity ?? null,
              sync_at: new Date(),
            },
            update: {
              name: p.title,
              price: parseFloat(p.variants[0]?.price ?? '0'),
              sync_at: new Date(),
            },
          });
          productsSynced++;
        }
      } else if (integration.platform === 'woocommerce') {
        const client = new WooCommerceClient(
          integration.store_url,
          integration.api_key ?? '',
          integration.api_secret ?? '',
        );

        const products = await client.getAllProducts();

        for (const p of products) {
          await this.prisma.ecommerce_products.upsert({
            where: {
              integration_id_external_product_id: {
                integration_id: integration.id,
                external_product_id: String(p.id),
              },
            },
            create: {
              integration_id: integration.id,
              external_product_id: String(p.id),
              name: p.name,
              description: p.description ?? null,
              price: parseFloat(p.price || '0'),
              currency: 'USD',
              image_url: p.images[0]?.src ?? null,
              product_url: p.permalink,
              inventory_count: p.stock_quantity ?? null,
              sync_at: new Date(),
            },
            update: {
              name: p.name,
              price: parseFloat(p.price || '0'),
              sync_at: new Date(),
            },
          });
          productsSynced++;
        }
      }

      await this.prisma.ecommerce_integrations.update({
        where: { id },
        data: { status: 'connected', last_sync_at: new Date(), sync_error: null },
      });

      this.logger.log(
        `[ecommerce sync] ${integration.platform} — products: ${productsSynced}, orders: ${ordersSynced}`,
      );
    } catch (err) {
      await this.prisma.ecommerce_integrations.update({
        where: { id },
        data: {
          status: 'error',
          sync_error: err instanceof Error ? err.message : 'Sync failed',
        },
      });
      throw err;
    }
  }
}
