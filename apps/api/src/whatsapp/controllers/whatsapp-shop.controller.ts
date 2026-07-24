import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Res,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import {
  syncCatalogItems,
  deleteCatalogItems,
  getCatalogBatchStatus,
  getCatalogInfo,
  fetchCatalogProducts,
  type CatalogProductInput,
  type CatalogBatchItemError,
} from '../meta-api.util';

const ORDER_STATUSES = ['pending', 'confirmed', 'cancelled', 'fulfilled'];

const CONTACT_SELECT = { select: { id: true, name: true, phone: true } };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * WhatsApp Shop endpoints (catalogue + orders tabs, inbox product picker):
 * - GET   /whatsapp/orders        → list orders with contact join
 * - PATCH /whatsapp/orders/:id    → update order status
 * - GET   /whatsapp/products      → list catalogue products
 * - POST  /whatsapp/products      → create product
 * - PATCH /whatsapp/products/:id  → update product
 * - DELETE /whatsapp/products/:id → delete product
 *
 * `price`/`total_amount` are Postgres numerics — Prisma returns Decimal,
 * which JSON-serializes as a string; the dashboard calls `.toFixed(2)` on
 * them, so they must go out as JSON numbers (as PostgREST used to send).
 */
@Controller('whatsapp')
@UseGuards(SupabaseAuthGuard)
export class WhatsappShopController {
  private readonly logger = new Logger(WhatsappShopController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get('orders')
  async listOrders(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    try {
      const orders = await this.prisma.whatsapp_orders.findMany({
        where: { account_id: account.accountId },
        include: { contacts: CONTACT_SELECT },
        orderBy: { created_at: 'desc' },
      });
      return res
        .status(HttpStatus.OK)
        .json({ orders: orders.map((o) => this.serializeOrder(o)) });
    } catch (err) {
      this.logger.error('[WhatsApp Orders GET]', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to fetch orders' });
    }
  }

  @Patch('orders/:id')
  @RequireRole('agent')
  async updateOrder(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() body: { status?: string },
    @Res() res: Response,
  ) {
    const { status } = body ?? {};
    if (!status || !ORDER_STATUSES.includes(status)) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Invalid order status' });
    }

    try {
      const { count } = await this.prisma.whatsapp_orders.updateMany({
        where: { id, account_id: account.accountId },
        data: { status, updated_at: new Date() },
      });
      if (count === 0) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .json({ error: 'Order not found' });
      }

      const order = await this.prisma.whatsapp_orders.findUnique({
        where: { id },
        include: { contacts: CONTACT_SELECT },
      });
      return res
        .status(HttpStatus.OK)
        .json({ order: order ? this.serializeOrder(order) : null });
    } catch (err) {
      this.logger.error('[WhatsApp Orders PATCH]', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to update order' });
    }
  }

  @Get('products')
  async listProducts(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    try {
      const products = await this.prisma.whatsapp_products.findMany({
        where: { account_id: account.accountId },
        orderBy: { created_at: 'desc' },
      });
      return res
        .status(HttpStatus.OK)
        .json({ products: products.map((p) => this.serializeProduct(p)) });
    } catch (err) {
      this.logger.error('[WhatsApp Products GET]', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to fetch products' });
    }
  }

  /**
   * POST /whatsapp/products/sync
   *
   * Push every local product into the Meta Commerce catalog linked to this
   * account (upsert by retailer_id). This is what makes product messages
   * actually deliverable — a product_retailer_id only works if the SKU exists
   * in the catalog. Requires a catalog id to be set (see PATCH /config/catalog).
   */
  @Post('products/sync')
  @RequireRole('agent')
  async syncProductsToMeta(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const creds = await this.loadCatalogCredentials(account.accountId);
    if ('error' in creds) {
      return res.status(creds.status).json({ error: creds.error });
    }

    const products = await this.prisma.whatsapp_products.findMany({
      where: { account_id: account.accountId },
    });
    if (products.length === 0) {
      return res
        .status(HttpStatus.OK)
        .json({ synced: 0, message: 'No products to sync.' });
    }

    const items: CatalogProductInput[] = products.map((p) => ({
      retailerId: p.retailer_id,
      name: p.name,
      description: p.description,
      priceAmount: Number(p.price),
      currency: p.currency || 'INR',
      imageUrl: p.image_url,
      available: p.is_active !== false,
    }));

    try {
      // Preflight: confirm the token can actually reach this catalog. The most
      // common sync failure is the WhatsApp token's system user not being
      // assigned to the catalog (or the token missing `catalog_management`),
      // which otherwise surfaces as an opaque items_batch error mid-batch.
      await getCatalogInfo({
        catalogId: creds.catalogId,
        accessToken: creds.accessToken,
      });

      const { handles } = await syncCatalogItems({
        catalogId: creds.catalogId,
        accessToken: creds.accessToken,
        products: items,
      });
      const errors = await this.pollBatchErrors(
        creds.catalogId,
        creds.accessToken,
        handles,
      );
      if (errors.length > 0) {
        return res.status(HttpStatus.OK).json({
          synced: products.length - errors.length,
          failed: errors.length,
          errors: errors.slice(0, 20),
        });
      }
      return res.status(HttpStatus.OK).json({ synced: products.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Catalog sync failed';
      this.logger.error(`[WhatsApp catalog sync] ${message}`);
      return res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: this.formatCatalogError(creds.catalogId, message) });
    }
  }

  /**
   * POST /whatsapp/products/import
   *
   * Pull direction (reverse of /products/sync): read every item from the Meta
   * Commerce catalog linked to this account and upsert it into local
   * `whatsapp_products` by retailer_id. This is how a catalog built in Commerce
   * Manager (or elsewhere) becomes visible/editable in the dashboard. Requires
   * a catalog id (see PATCH /config/catalog); does NOT require any local
   * products to already exist.
   */
  @Post('products/import')
  @RequireRole('agent')
  async importProductsFromMeta(
    @CurrentAccount() account: SupabaseAccountContext,
    @Res() res: Response,
  ) {
    const creds = await this.loadCatalogCredentials(account.accountId);
    if ('error' in creds) {
      return res.status(creds.status).json({ error: creds.error });
    }

    let remote;
    try {
      remote = await fetchCatalogProducts({
        catalogId: creds.catalogId,
        accessToken: creds.accessToken,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Catalog import failed';
      this.logger.error(`[WhatsApp catalog import] ${message}`);
      return res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: this.formatCatalogError(creds.catalogId, message) });
    }

    // Items without a retailer_id can't be keyed/sent — skip them.
    const usable = remote.filter((p) => p.retailerId && p.name);
    const skipped = remote.length - usable.length;
    if (usable.length === 0) {
      return res.status(HttpStatus.OK).json({
        imported: 0,
        updated: 0,
        skipped,
        message:
          remote.length === 0
            ? 'This catalog has no products.'
            : 'No importable products (all items were missing a Content ID / SKU).',
      });
    }

    // Classify created vs updated up front — upsert alone can't tell us.
    const existing = await this.prisma.whatsapp_products.findMany({
      where: {
        account_id: account.accountId,
        retailer_id: { in: usable.map((p) => p.retailerId) },
      },
      select: { retailer_id: true },
    });
    const existingIds = new Set(existing.map((e) => e.retailer_id));

    let imported = 0;
    let updated = 0;
    let failed = 0;
    for (const p of usable) {
      try {
        await this.prisma.whatsapp_products.upsert({
          where: {
            account_id_retailer_id: {
              account_id: account.accountId,
              retailer_id: p.retailerId,
            },
          },
          create: {
            account_id: account.accountId,
            retailer_id: p.retailerId,
            name: p.name,
            description: p.description,
            price: p.priceAmount,
            currency: p.currency || 'INR',
            image_url: p.imageUrl,
            is_active: p.available,
          },
          update: {
            name: p.name,
            description: p.description,
            price: p.priceAmount,
            currency: p.currency || 'INR',
            image_url: p.imageUrl,
            is_active: p.available,
            updated_at: new Date(),
          },
        });
        if (existingIds.has(p.retailerId)) updated++;
        else imported++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `[WhatsApp catalog import] upsert of "${p.retailerId}" failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return res
      .status(HttpStatus.OK)
      .json({ imported, updated, skipped, failed });
  }

  /**
   * Turn Meta's opaque "object does not exist / missing permissions" family of
   * errors into an actionable message. The catalog almost always DOES exist —
   * the WhatsApp token just can't manage it.
   */
  private formatCatalogError(catalogId: string, message: string): string {
    const permissionish =
      /does not exist|missing permission|cannot be loaded|does not support this operation|catalog_management|unsupported (get|post) request|not been approved to use this api|application does not have|check the application capabilities|permission(s)? (error|denied)/i.test(
        message,
      );
    if (!permissionish) return message;
    return (
      `Meta won't let your WhatsApp access token manage catalog ${catalogId}. ` +
      `This almost always means the "catalog_management" permission is missing. Fix it: ` +
      `(1) In your Meta app → Use cases → Permissions and features, add "catalog_management" ` +
      `(it's fine while the app is in testing — Standard Access covers admins/developers/testers). ` +
      `(2) In Meta Business Settings, assign the System User that owns this token to the catalog ` +
      `with full control (Business Settings → Data Sources → Catalogs → select the catalog → ` +
      `Assign/Add People). (3) Regenerate the token WITH the "catalog_management" scope and re-save ` +
      `it in WhatsApp settings. Meta's original error: ${message}`
    );
  }

  @Post('products')
  @RequireRole('agent')
  async createProduct(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const { retailer_id, name, description, price, currency, image_url, is_active } =
      (body ?? {}) as {
        retailer_id?: string;
        name?: string;
        description?: string;
        price?: string | number;
        currency?: string;
        image_url?: string;
        is_active?: boolean;
      };

    if (!retailer_id || !name || price === undefined) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'retailer_id, name, and price are required' });
    }

    try {
      const product = await this.prisma.whatsapp_products.create({
        data: {
          account_id: account.accountId,
          retailer_id,
          name,
          description,
          price: parseFloat(String(price)),
          currency: currency || 'INR',
          image_url,
          is_active: is_active !== false,
        },
      });
      return res
        .status(HttpStatus.CREATED)
        .json({ product: this.serializeProduct(product) });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return res.status(HttpStatus.CONFLICT).json({
          error: `A product with Retailer ID / SKU "${retailer_id}" already exists.`,
        });
      }
      this.logger.error('[WhatsApp Products POST]', err);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: err instanceof Error ? err.message : 'Failed to create product',
      });
    }
  }

  @Patch('products/:id')
  @RequireRole('agent')
  async updateProduct(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const { retailer_id, name, description, price, currency, image_url, is_active } =
      (body ?? {}) as {
        retailer_id?: string;
        name?: string;
        description?: string;
        price?: string | number;
        currency?: string;
        image_url?: string;
        is_active?: boolean;
      };

    const data: Prisma.whatsapp_productsUpdateManyMutationInput = {
      updated_at: new Date(),
    };
    if (retailer_id !== undefined) data.retailer_id = retailer_id;
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (price !== undefined) data.price = parseFloat(String(price));
    if (currency !== undefined) data.currency = currency;
    if (image_url !== undefined) data.image_url = image_url;
    if (is_active !== undefined) data.is_active = is_active;

    try {
      const { count } = await this.prisma.whatsapp_products.updateMany({
        where: { id, account_id: account.accountId },
        data,
      });
      if (count === 0) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .json({ error: 'Product not found' });
      }

      const product = await this.prisma.whatsapp_products.findUnique({
        where: { id },
      });
      return res
        .status(HttpStatus.OK)
        .json({ product: product ? this.serializeProduct(product) : null });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return res.status(HttpStatus.CONFLICT).json({
          error: `A product with Retailer ID / SKU "${String(retailer_id)}" already exists.`,
        });
      }
      this.logger.error('[WhatsApp Products PATCH]', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to update product' });
    }
  }

  @Delete('products/:id')
  @RequireRole('agent')
  async deleteProduct(
    @CurrentAccount() account: SupabaseAccountContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    try {
      const product = await this.prisma.whatsapp_products.findFirst({
        where: { id, account_id: account.accountId },
        select: { retailer_id: true },
      });
      if (!product) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .json({ error: 'Product not found' });
      }

      await this.prisma.whatsapp_products.deleteMany({
        where: { id, account_id: account.accountId },
      });

      // Best-effort: drop it from the Meta catalog too so we don't leave an
      // orphaned item that could still be sent. Fire-and-forget and fully
      // self-contained so it can never turn a successful delete into an error.
      void this.removeFromMetaCatalog(account.accountId, product.retailer_id);

      return res.status(HttpStatus.OK).json({ success: true });
    } catch (err) {
      this.logger.error('[WhatsApp Products DELETE]', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to delete product' });
    }
  }

  /**
   * Resolve the Meta catalog id + decrypted access token for an account, with
   * user-facing errors for each missing-prerequisite case.
   */
  private async loadCatalogCredentials(
    accountId: string,
  ): Promise<
    | { catalogId: string; accessToken: string }
    | { error: string; status: number }
  > {
    const config = await this.prisma.whatsapp_config.findFirst({
      where: { account_id: accountId },
      select: { catalog_id: true, access_token: true },
    });
    if (!config) {
      return {
        status: HttpStatus.BAD_REQUEST,
        error: 'WhatsApp is not connected. Connect it before syncing the catalog.',
      };
    }
    if (!config.catalog_id) {
      return {
        status: HttpStatus.BAD_REQUEST,
        error:
          'No Meta Catalog ID is set. Add your Catalog ID above before syncing products.',
      };
    }
    try {
      return {
        catalogId: config.catalog_id,
        accessToken: decrypt(config.access_token),
      };
    } catch {
      return {
        status: HttpStatus.BAD_REQUEST,
        error:
          'Stored access token could not be decrypted. Reset your WhatsApp connection.',
      };
    }
  }

  /**
   * Best-effort removal of a single item from the Meta catalog. Never throws —
   * catalog cleanup must not affect the local delete's outcome.
   */
  private async removeFromMetaCatalog(
    accountId: string,
    retailerId: string,
  ): Promise<void> {
    try {
      const creds = await this.loadCatalogCredentials(accountId);
      if ('error' in creds) return;
      await deleteCatalogItems({
        catalogId: creds.catalogId,
        accessToken: creds.accessToken,
        retailerIds: [retailerId],
      });
    } catch (err) {
      this.logger.warn(
        `[WhatsApp catalog] delete of "${retailerId}" from Meta failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Batch submission is async — poll the first handle briefly to catch item
   * validation errors. Bounded so the request stays responsive; if Meta is
   * still processing after a few tries we treat the batch as accepted.
   */
  private async pollBatchErrors(
    catalogId: string,
    accessToken: string,
    handles: string[],
  ): Promise<CatalogBatchItemError[]> {
    if (handles.length === 0) return [];
    const handle = handles[0];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const status = await getCatalogBatchStatus({
          catalogId,
          accessToken,
          handle,
        });
        if (status.errors.length > 0) return status.errors;
        if (status.finished) return [];
      } catch (err) {
        this.logger.warn(
          `[WhatsApp catalog] status check failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [];
      }
      await sleep(1200);
    }
    return [];
  }

  /** Rename the Prisma `contacts` relation to the legacy `contact` key and numberify Decimals. */
  private serializeOrder(order: {
    contacts?: { id: string; name: string | null; phone: string | null } | null;
    total_amount: Prisma.Decimal;
    [key: string]: unknown;
  }) {
    const { contacts, ...rest } = order;
    return {
      ...rest,
      total_amount: Number(order.total_amount),
      contact: contacts ?? null,
    };
  }

  private serializeProduct(product: {
    price: Prisma.Decimal;
    [key: string]: unknown;
  }) {
    return { ...product, price: Number(product.price) };
  }
}
