import { PrismaService } from '../../../prisma/prisma.service';
import type { ToolDefinition } from '../types';

/**
 * ============================================================
 * Built-in tools — the ones backed by this database.
 *
 * A skill unlocks a tool (see `lib/skills.ts`), and the tool reads or
 * writes the account's own data. That is the difference between an agent
 * that says "let me check your order" and one that actually checks.
 *
 * TENANT SCOPING IS NOT OPTIONAL HERE. Every query below filters on the
 * `accountId` the RUNTIME supplies, never on anything the model passed:
 * Prisma connects as the database owner, so RLS is not protecting these
 * queries (see CLAUDE.md → tenant-scoping traps). A model that
 * hallucinates `account_id` in its arguments must be unable to express
 * it — which is why no tool schema below has such a parameter.
 *
 * Order and lead tools are additionally scoped to the CONTACT in the
 * conversation. "What's my order status" must not become an order-lookup
 * oracle for the whole tenant, and the model cannot be trusted to
 * restrict itself to the right customer.
 * ============================================================
 */

export interface BuiltinToolContext {
  prisma: PrismaService;
  accountId: string;
  /** The customer in this conversation. Absent in the playground. */
  contactId: string | null;
  /** Who to attribute writes to (notes need a user id). */
  actorUserId: string | null;
  currency: string | null;
}

export interface BuiltinTool {
  definition: ToolDefinition;
  run: (
    args: Record<string, unknown>,
    ctx: BuiltinToolContext,
  ) => Promise<{ ok: boolean; detail: string }>;
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function money(amount: unknown, currency: string): string {
  const value = Number(amount);
  return Number.isFinite(value) ? `${currency} ${value.toFixed(2)}` : 'unknown';
}

const lookupOrders: BuiltinTool = {
  definition: {
    name: 'lookup_orders',
    description:
      "Look up this customer's own recent orders — status, total, items and order date. Returns nothing for an order that is not theirs.",
    parameters: {
      type: 'object',
      properties: {
        order_reference: {
          type: 'string',
          description:
            'Optional order number or id the customer quoted. Omit to list their recent orders.',
        },
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.contactId) {
      return {
        ok: false,
        detail:
          'No customer is attached to this conversation, so no orders can be looked up.',
      };
    }

    const reference = str(args, 'order_reference');
    const currency = ctx.currency ?? 'INR';

    const [waOrders, shopOrders] = await Promise.all([
      ctx.prisma.whatsapp_orders.findMany({
        where: { account_id: ctx.accountId, contact_id: ctx.contactId },
        orderBy: { created_at: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          total_amount: true,
          currency: true,
          items: true,
          created_at: true,
        },
      }),
      ctx.prisma.ecommerce_orders.findMany({
        where: {
          contact_id: ctx.contactId,
          // The account link lives on the integration, so scope through it.
          ecommerce_integrations: { account_id: ctx.accountId },
        },
        orderBy: { sync_at: 'desc' },
        take: 5,
        select: {
          external_order_id: true,
          status: true,
          total_amount: true,
          currency: true,
          order_url: true,
          sync_at: true,
        },
      }),
    ]);

    const lines: string[] = [];

    for (const order of waOrders) {
      const items = Array.isArray(order.items) ? order.items.length : 0;
      lines.push(
        [
          `Order ${order.id.slice(0, 8)}`,
          `status: ${order.status}`,
          `total: ${money(order.total_amount, order.currency || currency)}`,
          items ? `${items} item(s)` : null,
          order.created_at ? `placed ${order.created_at.toISOString().slice(0, 10)}` : null,
        ]
          .filter(Boolean)
          .join(' | '),
      );
    }

    for (const order of shopOrders) {
      lines.push(
        [
          `Order ${order.external_order_id}`,
          `status: ${order.status}`,
          `total: ${money(order.total_amount, order.currency || currency)}`,
          order.sync_at ? `updated ${order.sync_at.toISOString().slice(0, 10)}` : null,
        ]
          .filter(Boolean)
          .join(' | '),
      );
    }

    if (lines.length === 0) {
      return {
        ok: true,
        detail:
          'No orders found for this customer. Do not claim an order exists; ask them to confirm the number or the email it was placed with.',
      };
    }

    const matched = reference
      ? lines.filter((l) => l.toLowerCase().includes(reference.toLowerCase()))
      : lines;

    if (reference && matched.length === 0) {
      return {
        ok: true,
        detail: `No order matching "${reference}" for this customer. Their recent orders are:\n${lines.join('\n')}`,
      };
    }

    return { ok: true, detail: matched.join('\n') };
  },
};

const searchProducts: BuiltinTool = {
  definition: {
    name: 'search_products',
    description:
      "Search the business's own product catalogue by name or description. Returns real names, prices and links.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What the customer is looking for, in their own words.',
        },
        max_price: {
          type: 'number',
          description: 'Optional upper price limit, in the store currency.',
        },
      },
      required: ['query'],
    },
  },
  async run(args, ctx) {
    const query = str(args, 'query');
    if (!query) {
      return { ok: false, detail: 'A search query is required.' };
    }
    const maxPrice = Number(args.max_price);
    const priceFilter = Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : null;

    const [waProducts, shopProducts] = await Promise.all([
      ctx.prisma.whatsapp_products.findMany({
        where: {
          account_id: ctx.accountId,
          is_active: true,
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
          ],
          ...(priceFilter ? { price: { lte: priceFilter } } : {}),
        },
        take: 5,
        select: {
          name: true,
          description: true,
          price: true,
          currency: true,
          retailer_id: true,
        },
      }),
      ctx.prisma.ecommerce_products.findMany({
        where: {
          ecommerce_integrations: { account_id: ctx.accountId },
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
          ],
          ...(priceFilter ? { price: { lte: priceFilter } } : {}),
        },
        take: 5,
        select: {
          name: true,
          description: true,
          price: true,
          currency: true,
          product_url: true,
          inventory_count: true,
        },
      }),
    ]);

    const lines: string[] = [];

    for (const p of waProducts) {
      lines.push(
        [
          p.name,
          money(p.price, p.currency || ctx.currency || 'INR'),
          p.description ? p.description.slice(0, 160) : null,
        ]
          .filter(Boolean)
          .join(' — '),
      );
    }

    for (const p of shopProducts) {
      lines.push(
        [
          p.name,
          money(p.price, p.currency || ctx.currency || 'INR'),
          typeof p.inventory_count === 'number'
            ? p.inventory_count > 0
              ? 'in stock'
              : 'out of stock'
            : null,
          p.product_url,
        ]
          .filter(Boolean)
          .join(' — '),
      );
    }

    if (lines.length === 0) {
      return {
        ok: true,
        detail: `Nothing in the catalogue matches "${query}". Say so plainly rather than suggesting a product that was not returned.`,
      };
    }

    return { ok: true, detail: lines.slice(0, 5).join('\n') };
  },
};

const saveLeadDetails: BuiltinTool = {
  definition: {
    name: 'save_lead_details',
    description:
      'Record the qualification details collected from this customer against their contact record. Call once, after you have the details.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The customer's name, if given." },
        email: { type: 'string', description: 'Email address, if given.' },
        company: { type: 'string', description: 'Company name, if given.' },
        summary: {
          type: 'string',
          description:
            'What they want, in two or three sentences, including any budget, timeline or quantity they mentioned.',
        },
        qualified: {
          type: 'boolean',
          description: 'True when they meet the qualification criteria.',
        },
      },
      required: ['summary'],
    },
  },
  async run(args, ctx) {
    if (!ctx.contactId) {
      return {
        ok: false,
        detail:
          'No customer is attached to this conversation, so nothing was saved. Carry on the conversation normally.',
      };
    }

    const summary = str(args, 'summary');
    if (!summary) {
      return { ok: false, detail: 'A summary is required to save the lead.' };
    }

    const name = str(args, 'name');
    const email = str(args, 'email');
    const company = str(args, 'company');
    const qualified = args.qualified === true;

    // Contact fields are only FILLED IN, never overwritten: a human may
    // have corrected them, and a model's transcription of a name heard
    // over chat is the weaker source.
    const contact = await ctx.prisma.contacts.findFirst({
      where: { id: ctx.contactId, account_id: ctx.accountId },
      select: { id: true, name: true, email: true, company: true },
    });
    if (!contact) {
      return { ok: false, detail: 'That customer no longer exists.' };
    }

    const patch: Record<string, string> = {};
    if (name && !contact.name) patch.name = name.slice(0, 120);
    if (email && !contact.email) patch.email = email.slice(0, 200);
    if (company && !contact.company) patch.company = company.slice(0, 160);

    if (Object.keys(patch).length > 0) {
      await ctx.prisma.contacts.update({
        where: { id: contact.id },
        data: patch,
      });
    }

    if (ctx.actorUserId) {
      const header = qualified
        ? 'Qualified lead (AI agent)'
        : 'Lead details (AI agent)';
      await ctx.prisma.contact_notes.create({
        data: {
          account_id: ctx.accountId,
          contact_id: contact.id,
          user_id: ctx.actorUserId,
          note_text: `${header}\n\n${summary.slice(0, 4000)}`,
        },
      });
    }

    const saved = [
      Object.keys(patch).length > 0 ? `updated ${Object.keys(patch).join(', ')}` : null,
      ctx.actorUserId ? 'saved a note on the contact' : null,
    ]
      .filter(Boolean)
      .join(' and ');

    return {
      ok: true,
      detail: `Recorded${saved ? ` — ${saved}` : ''}. Confirm to the customer that the team has their details and will follow up; do not repeat the details back as a list.`,
    };
  },
};

export const BUILTIN_TOOLS: Record<string, BuiltinTool> = {
  lookup_orders: lookupOrders,
  search_products: searchProducts,
  save_lead_details: saveLeadDetails,
};

export function builtinToolsByName(names: string[]): BuiltinTool[] {
  return names
    .map((name) => BUILTIN_TOOLS[name])
    .filter((tool): tool is BuiltinTool => Boolean(tool));
}
