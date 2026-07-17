import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { WhatsappShopController } from './whatsapp-shop.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';

// Regression coverage for the WhatsApp Shop endpoints (orders + catalogue) —
// the legacy Next.js routes were deleted in Phase 4 before this port existed.

const account: SupabaseAccountContext = {
  authType: 'supabase',
  userId: 'user-1',
  accountId: 'acc-1',
  role: 'agent',
  account: { id: 'acc-1', name: 'Test' },
};

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

function makePrismaMock() {
  return {
    whatsapp_orders: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    whatsapp_products: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

const ORDER_ROW = {
  id: 'order-1',
  account_id: 'acc-1',
  status: 'pending',
  total_amount: new Prisma.Decimal('149.50'),
  currency: 'INR',
  items: [],
  contacts: { id: 'c-1', name: 'Asha', phone: '+911234567890' },
};

const PRODUCT_ROW = {
  id: 'prod-1',
  account_id: 'acc-1',
  retailer_id: 'SKU-1',
  name: 'Widget',
  price: new Prisma.Decimal('99.00'),
  currency: 'INR',
  is_active: true,
};

describe('WhatsappShopController', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let controller: WhatsappShopController;

  beforeEach(() => {
    prisma = makePrismaMock();
    controller = new WhatsappShopController(prisma as unknown as PrismaService);
  });

  describe('orders', () => {
    it('lists orders account-scoped, renaming contacts→contact and numberifying Decimals', async () => {
      prisma.whatsapp_orders.findMany.mockResolvedValueOnce([ORDER_ROW]);
      const res = makeRes();

      await controller.listOrders(account, res);

      expect(prisma.whatsapp_orders.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { account_id: 'acc-1' } }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0] as { orders: any[] };
      expect(body.orders[0].total_amount).toBe(149.5);
      expect(body.orders[0].contact).toEqual(ORDER_ROW.contacts);
      expect(body.orders[0]).not.toHaveProperty('contacts');
    });

    it('rejects an invalid status with the legacy 400 message', async () => {
      const res = makeRes();
      await controller.updateOrder(account, 'order-1', { status: 'shipped' }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid order status' });
      expect(prisma.whatsapp_orders.updateMany).not.toHaveBeenCalled();
    });

    it('404s when the order belongs to another account', async () => {
      prisma.whatsapp_orders.updateMany.mockResolvedValueOnce({ count: 0 });
      const res = makeRes();

      await controller.updateOrder(account, 'order-x', { status: 'confirmed' }, res);

      expect(prisma.whatsapp_orders.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-x', account_id: 'acc-1' },
        }),
      );
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('updates the status and returns the reshaped order', async () => {
      prisma.whatsapp_orders.findUnique.mockResolvedValueOnce({
        ...ORDER_ROW,
        status: 'confirmed',
      });
      const res = makeRes();

      await controller.updateOrder(account, 'order-1', { status: 'confirmed' }, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0] as { order: any };
      expect(body.order.status).toBe('confirmed');
      expect(body.order.total_amount).toBe(149.5);
      expect(body.order.contact).toEqual(ORDER_ROW.contacts);
    });
  });

  describe('products', () => {
    it('lists products with numeric prices', async () => {
      prisma.whatsapp_products.findMany.mockResolvedValueOnce([PRODUCT_ROW]);
      const res = makeRes();

      await controller.listProducts(account, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0] as { products: any[] };
      expect(body.products[0].price).toBe(99);
    });

    it('400s with the legacy message when required fields are missing', async () => {
      const res = makeRes();
      await controller.createProduct(account, { name: 'No SKU' }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'retailer_id, name, and price are required',
      });
    });

    it('creates a product with defaults and returns 201', async () => {
      prisma.whatsapp_products.create.mockResolvedValueOnce(PRODUCT_ROW);
      const res = makeRes();

      await controller.createProduct(
        account,
        { retailer_id: 'SKU-1', name: 'Widget', price: '99.00' },
        res,
      );

      expect(prisma.whatsapp_products.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          account_id: 'acc-1',
          retailer_id: 'SKU-1',
          price: 99,
          currency: 'INR',
          is_active: true,
        }),
      });
      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.json.mock.calls[0][0] as { product: any };
      expect(body.product.price).toBe(99);
    });

    it('maps a duplicate retailer_id (P2002) to the legacy 409 message', async () => {
      prisma.whatsapp_products.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      const res = makeRes();

      await controller.createProduct(
        account,
        { retailer_id: 'SKU-1', name: 'Widget', price: 5 },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: 'A product with Retailer ID / SKU "SKU-1" already exists.',
      });
    });

    it('applies partial updates only for provided fields', async () => {
      prisma.whatsapp_products.findUnique.mockResolvedValueOnce({
        ...PRODUCT_ROW,
        name: 'Renamed',
      });
      const res = makeRes();

      await controller.updateProduct(account, 'prod-1', { name: 'Renamed' }, res);

      const { data } = prisma.whatsapp_products.updateMany.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data.name).toBe('Renamed');
      expect(data).not.toHaveProperty('price');
      expect(data.updated_at).toBeInstanceOf(Date);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('404s on deleting a product outside the account', async () => {
      prisma.whatsapp_products.findFirst.mockResolvedValueOnce(null);
      const res = makeRes();

      await controller.deleteProduct(account, 'prod-x', res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Product not found' });
      expect(prisma.whatsapp_products.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes an owned product and returns {success: true}', async () => {
      prisma.whatsapp_products.findFirst.mockResolvedValueOnce({ retailer_id: 'SKU-1' });
      const res = makeRes();

      await controller.deleteProduct(account, 'prod-1', res);

      expect(prisma.whatsapp_products.deleteMany).toHaveBeenCalledWith({
        where: { id: 'prod-1', account_id: 'acc-1' },
      });
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });
  });
});
