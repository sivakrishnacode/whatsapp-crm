import { PrismaService } from '../../../prisma/prisma.service';
import type { AgentSkills, ToolDefinition } from '../types';
import { skillText } from '../skills';
import { GOOGLE_TOOLS } from './google';

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
  /** The thread this run belongs to. Absent in the playground. */
  conversationId: string | null;
  /** Who to attribute writes to (notes need a user id). */
  actorUserId: string | null;
  currency: string | null;
  /**
   * The agent's resolved per-skill config.
   *
   * A tool needs this whenever the right value is something an ADMIN
   * chose rather than something the model can know — a default pipeline,
   * say. Without it those fields are collected by the studio UI and read
   * by nothing, which is how `deal_pipeline_id` sat unused while
   * `create_deal` demanded the same id from a model that had no way to
   * find one.
   */
  skills: AgentSkills;
  /**
   * The workspace's Apps Script bridge, when Google is set up.
   *
   * Absent rather than always-present on purpose: `agent-runtime` only
   * supplies it once it has confirmed a deployment exists, and the Google
   * tools are withheld from the model in the same breath. A tool that
   * reached a missing bridge would burn a tool round and a credit to
   * learn what the runtime already knew.
   */
  googleScript?: {
    run: (
      accountId: string,
      actionId: string,
      input: Record<string, unknown>,
    ) => Promise<{ output: Record<string, unknown>; detail?: string }>;
  };
}

/** One skill's saved config, defensively — it comes from JSONB. */
function skillConfig(
  ctx: BuiltinToolContext,
  skillId: string,
): Record<string, unknown> {
  const entry = ctx.skills?.[skillId];
  return entry && typeof entry.config === 'object' && entry.config !== null
    ? (entry.config as Record<string, unknown>)
    : {};
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
          order.created_at
            ? `placed ${order.created_at.toISOString().slice(0, 10)}`
            : null,
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
          order.sync_at
            ? `updated ${order.sync_at.toISOString().slice(0, 10)}`
            : null,
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
    const priceFilter =
      Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : null;

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
      Object.keys(patch).length > 0
        ? `updated ${Object.keys(patch).join(', ')}`
        : null,
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

const createDeal: BuiltinTool = {
  definition: {
    name: 'create_deal',
    description:
      'Create a new deal in the sales pipeline from what the customer said. ' +
      'Only a title is required — the pipeline and stage are chosen automatically, ' +
      'so never ask the customer for them and never invent an id.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Deal name or project title from the conversation.',
        },
        value: {
          type: 'number',
          description: 'Optional estimated deal value or budget amount.',
        },
        notes: {
          type: 'string',
          description:
            'Optional summary of the opportunity, customer requirements, or timeline.',
        },
      },
      required: ['title'],
    },
  },
  async run(args, ctx) {
    const title = str(args, 'title');
    if (!title) {
      return { ok: false, detail: 'Deal title is required.' };
    }

    const notes = str(args, 'notes');
    const value = Number(args.value);

    /**
     * ⚠️ WHERE THE DEAL GOES IS RESOLVED HERE, NOT ASKED OF THE MODEL.
     *
     * This shipped with `pipeline_id` and `stage_id` as REQUIRED tool
     * parameters, and the model has no way to know either: nothing lists
     * pipelines, the skill prompt never mentions ids, and asking the
     * customer for a UUID is absurd. So every call either omitted them
     * and failed validation or invented one and failed the lookup —
     * the skill could not create a deal at all, and the failure was
     * invisible because a tool result only goes back to the model.
     *
     * The order is: what an admin configured, then the workspace's own
     * first pipeline. Both ids are still validated against the account,
     * because a configured id is data too.
     */
    const cfg = skillConfig(ctx, 'create_deal');
    const wantedPipelineId = skillText(cfg, 'deal_pipeline_id');
    const wantedStageId = skillText(cfg, 'deal_stage_id');

    try {
      /**
       * ⚠️ ONE DEAL PER CONVERSATION.
       *
       * Nothing stops a model calling a tool twice, and it does: two
       * messages in one thread produced "CRM and HRMS Tool Project" and
       * "CRM and HRMS Software" for the same customer, same value,
       * minutes apart. Neither is wrong on its own, so no title or value
       * check catches it — the thread is what makes them the same deal.
       *
       * Scoped to the CONVERSATION and not the contact deliberately: a
       * customer legitimately has several open deals at once (a website
       * and a wedding order are not duplicates), and a later enquiry
       * arrives on its own thread and still earns its own deal.
       *
       * ⚠️ AND IT IS AN UPSERT, NOT A REFUSAL.
       *
       * "I have to update my requirement, my budget is 40k" is the second
       * call on a thread, so the guard catches it — but simply declining
       * made the bot answer "Got it, I've noted the updated budget of
       * 40k" while the deal still said 50k. Preventing the duplicate by
       * making the reply untrue is a worse bug than the duplicate: the
       * customer is told a thing that is not in the CRM, and nobody finds
       * out until the invoice.
       *
       * So a repeat call MOVES the existing deal. What it may touch is
       * narrow on purpose:
       *   value — yes, only when a new one is supplied and it differs.
       *           This is the thing the customer just changed.
       *   notes — APPENDED, never replaced, so the earlier requirement
       *           survives next to the update.
       *   title — never. A human reads it in the pipeline; renaming it
       *           under them on every message is churn, and the model
       *           invents a slightly different wording each time (which
       *           is how this whole mess started).
       *   stage, assignment — never. A human may have moved it, and the
       *           customer restating a budget is not a reason to drag a
       *           deal back to New Lead.
       */
      if (ctx.conversationId) {
        const existing = await ctx.prisma.deals.findFirst({
          where: {
            account_id: ctx.accountId,
            conversation_id: ctx.conversationId,
            status: 'open',
          },
          orderBy: { created_at: 'desc' },
          select: { id: true, title: true, value: true, notes: true },
        });

        if (existing) {
          const nextValue = Number.isFinite(value) && value > 0 ? value : null;
          const valueChanged =
            nextValue !== null && Number(existing.value) !== nextValue;

          const patch: { value?: number; notes?: string } = {};
          if (valueChanged) patch.value = nextValue;
          if (notes && notes !== existing.notes) {
            patch.notes = [existing.notes, notes]
              .filter(Boolean)
              .join('\n\n')
              .slice(0, 4000);
          }

          if (Object.keys(patch).length === 0) {
            return {
              ok: true,
              detail:
                `This conversation already has an open deal: "${existing.title}" ` +
                `(deal_id: ${existing.id}), and nothing you passed changes it. ` +
                `Refer to the existing one rather than announcing a new deal.`,
            };
          }

          await ctx.prisma.deals.update({
            where: { id: existing.id },
            data: patch,
          });

          const currencyLabel = ctx.currency?.toUpperCase() || 'USD';
          return {
            ok: true,
            detail:
              `Updated the existing deal "${existing.title}" (deal_id: ${existing.id})` +
              (valueChanged
                ? ` — value ${currencyLabel} ${Number(existing.value)} to ${currencyLabel} ${nextValue}`
                : ' — requirements added') +
              `. No second deal was created.`,
          };
        }
      }

      const pipeline = wantedPipelineId
        ? await ctx.prisma.pipelines.findFirst({
            where: { id: wantedPipelineId, account_id: ctx.accountId },
            select: { id: true, name: true },
          })
        : await ctx.prisma.pipelines.findFirst({
            where: { account_id: ctx.accountId },
            orderBy: { created_at: 'asc' },
            select: { id: true, name: true },
          });

      if (!pipeline) {
        return {
          ok: false,
          detail: wantedPipelineId
            ? 'The configured default pipeline no longer exists in this workspace.'
            : 'This workspace has no pipeline yet, so there is nowhere to file a deal.',
        };
      }

      // Scoped through `pipeline_id`, which is what keeps a stage from
      // another pipeline (or another tenant) out. A configured stage that
      // does not belong to the resolved pipeline falls back to the first
      // one rather than failing: stale config should not cost a deal that
      // the conversation has already earned.
      const stage =
        (wantedStageId
          ? await ctx.prisma.pipeline_stages.findFirst({
              where: { id: wantedStageId, pipeline_id: pipeline.id },
              select: { id: true, name: true },
            })
          : null) ??
        (await ctx.prisma.pipeline_stages.findFirst({
          where: { pipeline_id: pipeline.id },
          orderBy: { position: 'asc' },
          select: { id: true, name: true },
        }));

      if (!stage) {
        return {
          ok: false,
          detail: `Pipeline "${pipeline.name}" has no stages, so there is nowhere to place the deal.`,
        };
      }

      const pipelineId = pipeline.id;
      const stageId = stage.id;

      const owner = await ctx.prisma.account.findUnique({
        where: { id: ctx.accountId },
        select: { ownerUserId: true },
      });

      if (!owner?.ownerUserId) {
        return {
          ok: false,
          detail: 'This workspace has no owner to file the deal under.',
        };
      }

      /**
       * ⚠️ `user_id` AND `assigned_to` ARE NOT THE SAME KIND OF ID.
       *
       * `deals.user_id` references `auth.users`, but
       * `deals.assigned_to` references `profiles(id)` (migration 002) —
       * and `profiles.id` is its own `gen_random_uuid()`, NOT the user id
       * (001 inserts only `user_id`). Writing the owner's user id into
       * both — as this shipped — is a foreign-key violation, so the
       * INSERT threw, the catch below turned it into a tool error, and no
       * deal was created. Nothing surfaced: a tool result is only ever
       * read by the model.
       *
       * Left NULL when the owner somehow has no profile row: an
       * unassigned deal is worth far more than no deal.
       */
      const ownerProfile = await ctx.prisma.profile.findFirst({
        where: { userId: owner.ownerUserId, accountId: ctx.accountId },
        select: { id: true },
      });

      const currency = ctx.currency?.toUpperCase() || 'USD';
      const dealValue = Number.isFinite(value) ? value : 0;

      const deal = await ctx.prisma.deals.create({
        data: {
          account_id: ctx.accountId,
          pipeline_id: pipelineId,
          stage_id: stageId,
          user_id: owner.ownerUserId,
          assigned_to: ownerProfile?.id ?? null,
          contact_id: ctx.contactId,
          // Provenance, and the key the guard above reads next time.
          conversation_id: ctx.conversationId,
          title: title.slice(0, 255),
          value: dealValue,
          currency,
          notes: notes ? notes.slice(0, 4000) : null,
          status: 'open',
        },
        select: { id: true, title: true, value: true },
      });

      // The id is in the detail because `assign_deal` is the natural next
      // call and a tool result is the only thing the model carries
      // forward. Without it the two deal skills cannot be chained at all.
      return {
        ok: true,
        detail:
          `Deal "${deal.title}" created in pipeline "${pipeline.name}" at stage "${stage.name}" ` +
          `(value: ${currency} ${deal.value}, deal_id: ${deal.id})`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `Failed to create deal: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

const assignDeal: BuiltinTool = {
  definition: {
    name: 'assign_deal',
    description:
      'Hand a deal to a teammate by their NAME or email — the same name you would say out loud. ' +
      'Omit `deal_id` to assign the deal most recently opened for this customer.',
    parameters: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          description:
            'The teammate\'s name or email address, e.g. "Priya" or "priya@acme.com".',
        },
        deal_id: {
          type: 'string',
          description:
            "Optional. The id returned by create_deal. Omit to use this customer's newest open deal.",
        },
      },
      required: ['assignee'],
    },
  },
  async run(args, ctx) {
    /**
     * ⚠️ THE MODEL NAMES A PERSON; THE SERVER RESOLVES THE ID.
     *
     * This shipped requiring `assigned_to_user_id` — a `profiles.id`
     * UUID. Nothing lists teammates, so the model could not produce one
     * and the skill never assigned anything. Worse, the lookup that
     * claimed to "verify target user is a team member on this account"
     * queried `profile.findFirst({ where: { id } })` with NO account
     * filter, so a guessed id from ANOTHER TENANT passed the check and
     * the deal was handed to somebody outside the workspace. Prisma
     * connects as the database owner, so RLS was not going to stop it
     * (CLAUDE.md → tenant-scoping traps).
     *
     * Matching on a name is why the account filter is now load-bearing
     * twice over: it scopes the search AND it is the only thing that
     * makes "Priya" mean this workspace's Priya.
     */
    const assignee = str(args, 'assignee');
    if (!assignee) {
      return { ok: false, detail: 'Name the teammate to assign the deal to.' };
    }

    const requestedDealId = str(args, 'deal_id');

    try {
      // A deal id from the model is data, not authority — always scoped.
      const deal = requestedDealId
        ? await ctx.prisma.deals.findFirst({
            where: { id: requestedDealId, account_id: ctx.accountId },
            select: { id: true, title: true },
          })
        : ctx.contactId
          ? await ctx.prisma.deals.findFirst({
              where: {
                account_id: ctx.accountId,
                contact_id: ctx.contactId,
                status: 'open',
              },
              orderBy: { created_at: 'desc' },
              select: { id: true, title: true },
            })
          : null;

      if (!deal) {
        return {
          ok: false,
          detail: requestedDealId
            ? 'That deal does not exist in this workspace.'
            : 'This customer has no open deal to assign — create one first.',
        };
      }

      // Exact email first, then a case-insensitive name match. Both
      // pinned to this account.
      const candidates = await ctx.prisma.profile.findMany({
        where: {
          accountId: ctx.accountId,
          OR: [
            { email: { equals: assignee, mode: 'insensitive' } },
            { fullName: { contains: assignee, mode: 'insensitive' } },
          ],
        },
        select: { id: true, fullName: true, email: true },
        take: 5,
      });

      if (candidates.length === 0) {
        return {
          ok: false,
          detail: `Nobody on this team matches "${assignee}".`,
        };
      }

      // Two people called "Ann" must not resolve to whichever row came
      // back first — the deal would silently land on the wrong desk.
      const exact = candidates.filter(
        (c) =>
          c.email.toLowerCase() === assignee.toLowerCase() ||
          c.fullName.toLowerCase() === assignee.toLowerCase(),
      );
      const member = exact.length === 1 ? exact[0] : null;

      if (!member) {
        if (candidates.length > 1) {
          return {
            ok: false,
            detail: `"${assignee}" matches more than one teammate (${candidates
              .map((c) => c.fullName)
              .join(', ')}) — use their full name or email.`,
          };
        }
        // A single fuzzy match is the ordinary case: "Priya" → "Priya Nair".
        return assignDealTo(ctx, deal, candidates[0]);
      }

      return assignDealTo(ctx, deal, member);
    } catch (error) {
      return {
        ok: false,
        detail: `Failed to assign deal: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

/** `deals.assigned_to` references `profiles(id)` — see create_deal. */
async function assignDealTo(
  ctx: BuiltinToolContext,
  deal: { id: string; title: string },
  member: { id: string; fullName: string },
): Promise<{ ok: boolean; detail: string }> {
  await ctx.prisma.deals.update({
    where: { id: deal.id },
    data: { assigned_to: member.id },
  });
  return {
    ok: true,
    detail: `Deal "${deal.title}" assigned to ${member.fullName || 'team member'}.`,
  };
}

const triggerAutomation: BuiltinTool = {
  definition: {
    name: 'trigger_automation',
    description:
      'Trigger an automation workflow based on the conversation context. Used to fire internal processes like sending notifications, updating contact fields, or creating tasks.',
    parameters: {
      type: 'object',
      properties: {
        automation_type: {
          type: 'string',
          description:
            'Type of automation to trigger: send_email, update_contact, create_task, notify_team, etc.',
        },
        automation_id: {
          type: 'string',
          description: 'Optional ID of a specific automation to trigger.',
        },
        parameters: {
          type: 'object',
          description:
            'Optional parameters for the automation, such as email address, task title, notification message.',
          additionalProperties: true,
        },
      },
      required: ['automation_type'],
    },
  },
  async run(args, ctx) {
    const automationType = str(args, 'automation_type');
    const automationId = str(args, 'automation_id');

    if (!automationType) {
      return { ok: false, detail: 'Automation type is required.' };
    }

    // Whitelist of allowed automation types to prevent abuse
    const allowedTypes = [
      'send_email',
      'send_sms',
      'update_contact',
      'create_task',
      'notify_team',
      'add_tag',
      'add_to_segment',
      'schedule_followup',
    ];

    if (!allowedTypes.includes(automationType)) {
      return {
        ok: false,
        detail: `Automation type "${automationType}" is not allowed. Allowed types: ${allowedTypes.join(', ')}`,
      };
    }

    if (!ctx.contactId) {
      return {
        ok: false,
        detail:
          'No customer is attached to this conversation, so automations cannot be triggered. This is a safety measure to prevent unintended actions.',
      };
    }

    try {
      // Log the automation trigger for audit purposes
      if (ctx.actorUserId) {
        await ctx.prisma.contact_notes.create({
          data: {
            account_id: ctx.accountId,
            contact_id: ctx.contactId,
            user_id: ctx.actorUserId,
            note_text: `[AI Automation] Triggered: ${automationType}${automationId ? ` (${automationId})` : ''}`,
          },
        });
      }

      return {
        ok: true,
        detail: `Automation "${automationType}" queued${automationId ? ` (ID: ${automationId})` : ''}. It will be processed in the background.`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `Failed to trigger automation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

export const BUILTIN_TOOLS: Record<string, BuiltinTool> = {
  lookup_orders: lookupOrders,
  search_products: searchProducts,
  save_lead_details: saveLeadDetails,
  create_deal: createDeal,
  assign_deal: assignDeal,
  trigger_automation: triggerAutomation,
  // Backed by the customer's own Apps Script deployment rather than this
  // database, and gated twice in agent-runtime: withheld when Google is
  // not connected, and the writing ones withheld again while drafting.
  ...GOOGLE_TOOLS,
};

export function builtinToolsByName(names: string[]): BuiltinTool[] {
  return names
    .map((name) => BUILTIN_TOOLS[name])
    .filter((tool): tool is BuiltinTool => Boolean(tool));
}
