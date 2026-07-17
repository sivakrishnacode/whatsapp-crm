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

const ORDER_STATUSES = ['pending', 'confirmed', 'cancelled', 'fulfilled'];

const CONTACT_SELECT = { select: { id: true, name: true, phone: true } };

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
      return res.status(HttpStatus.OK).json({ success: true });
    } catch (err) {
      this.logger.error('[WhatsApp Products DELETE]', err);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Failed to delete product' });
    }
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
