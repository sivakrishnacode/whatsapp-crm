import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopifyClient } from '../utils/shopify.client.js';
import { WooCommerceClient } from '../utils/woocommerce.client.js';

/**
 * Pulls a connected store's catalogue into `ecommerce_products`.
 *
 * Lifted out of `EcommerceController` when store syncs moved onto a
 * queue. The controller kept it as a private method invoked with
 * `void this.runSync(...)` — a full multi-page import running detached
 * inside a request handler, with no retry and no record of it having
 * been asked for. A deploy halfway through left the integration stuck
 * on `status: 'syncing'` with a partial catalogue and nothing to
 * resume it.
 *
 * Takes an id, not an integration row. The row holds `api_key`,
 * `api_secret` and `access_token`; passing it through a job payload
 * would write a customer's store credentials into Redis in plaintext,
 * where the queue dashboard would then display them.
 */
@Injectable()
export class EcommerceSyncService {
  private readonly logger = new Logger(EcommerceSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async syncIntegration(integrationId: string): Promise<void> {
    const integration = await this.prisma.ecommerce_integrations.findUnique({
      where: { id: integrationId },
      select: {
        id: true,
        account_id: true,
        platform: true,
        store_url: true,
        api_key: true,
        api_secret: true,
        access_token: true,
      },
    });
    // Disconnected between the request and the job. Not an error.
    if (!integration) return;

    let productsSynced = 0;
    const ordersSynced = 0;

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
        where: { id: integration.id },
        data: {
          status: 'connected',
          last_sync_at: new Date(),
          sync_error: null,
        },
      });

      this.logger.log(
        `[ecommerce sync] ${integration.platform} — products: ${productsSynced}, orders: ${ordersSynced}`,
      );
    } catch (err) {
      // Recorded on the row *and* rethrown: the row is what the user
      // sees, and the throw is what makes BullMQ try again. The final
      // attempt's message is the one that sticks.
      await this.prisma.ecommerce_integrations.update({
        where: { id: integration.id },
        data: {
          status: 'error',
          sync_error: err instanceof Error ? err.message : 'Sync failed',
        },
      });
      throw err;
    }
  }
}
