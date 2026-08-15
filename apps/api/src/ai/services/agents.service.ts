import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../../subscription/services/entitlement.service';
import {
  AGENT_TEMPLATES,
  findAgentTemplate,
  templateSkills,
} from '../lib/agent-templates';
import { sanitizeSkills } from '../lib/skills';

/** Channels an agent may be scoped to. Mirrors conversations_channel_chk. */
export const AGENT_CHANNELS = ['whatsapp', 'instagram', 'web'] as const;
export type AgentChannel = (typeof AGENT_CHANNELS)[number];

/** How far back the list's per-agent numbers look. */
const STATS_WINDOW_DAYS = 30;

export interface AgentStats {
  replies: number;
  conversations: number;
  handoffs: number;
}

/**
 * ============================================================
 * The agent list: create, duplicate, reorder, delete, and the numbers
 * shown next to each row.
 *
 * The per-agent CONFIGURATION (persona, tone, skills, escalation) is
 * `AgentConfigService`'s job. This service owns the things that are
 * true of an agent as an object in a list rather than as a personality:
 * how many there may be, what order they are tried in, and what each one
 * has actually done.
 * ============================================================
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
  ) {}

  templates() {
    return AGENT_TEMPLATES.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      icon: t.icon,
      name: t.name,
      skills: t.skills,
    }));
  }

  /**
   * Every agent in the workspace, in the order routing tries them, with
   * 30 days of numbers each.
   *
   * The stats are three grouped queries rather than one per agent: a
   * workspace with five agents must not cost fifteen round trips to
   * render one screen.
   */
  async list(accountId: string) {
    const since = new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000);

    const [agents, workspace, limit, replies, conversations, handoffs] =
      await Promise.all([
        this.prisma.ai_agents.findMany({
          where: { account_id: accountId },
          orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
        }),
        this.prisma.ai_configs.findUnique({
          where: { account_id: accountId },
          select: {
            provider: true,
            model: true,
            api_key: true,
            credit_mode: true,
            embeddings_model: true,
          },
        }),
        this.entitlement.checkLimit(accountId, 'ai_agents', 0),
        this.prisma.messages.groupBy({
          by: ['ai_agent_id'],
          where: {
            ai_agent_id: { not: null },
            created_at: { gte: since },
            conversations: { account_id: accountId },
          },
          _count: { _all: true },
        }),
        this.prisma.conversations.groupBy({
          by: ['ai_agent_id'],
          where: {
            account_id: accountId,
            ai_agent_id: { not: null },
            updated_at: { gte: since },
          },
          _count: { _all: true },
        }),
        this.prisma.conversations.groupBy({
          by: ['ai_agent_id'],
          where: {
            account_id: accountId,
            ai_agent_id: { not: null },
            ai_handoff_at: { gte: since },
          },
          _count: { _all: true },
        }),
      ]);

    const statOf = (
      rows: Array<{ ai_agent_id: string | null; _count: { _all: number } }>,
      id: string,
    ) => rows.find((r) => r.ai_agent_id === id)?._count._all ?? 0;

    return {
      agents: agents.map((agent) => ({
        ...this.publicAgent(agent),
        // What this agent will actually run on, resolved the same way
        // the runtime resolves it — so the row cannot claim a model the
        // agent would never use.
        resolved_provider:
          workspace?.credit_mode === 'byok' && workspace?.api_key
            ? workspace.provider
            : 'gemini',
        resolved_model:
          workspace?.credit_mode === 'byok' && workspace?.api_key
            ? (agent.model ?? workspace.model)
            : null,
        stats: {
          replies: statOf(replies, agent.id),
          conversations: statOf(conversations, agent.id),
          handoffs: statOf(handoffs, agent.id),
        } satisfies AgentStats,
      })),
      stats_window_days: STATS_WINDOW_DAYS,
      workspace: {
        configured: Boolean(workspace),
        has_key: Boolean(workspace?.api_key),
        provider: workspace?.provider ?? null,
        model: workspace?.model ?? null,
        credit_mode: workspace?.credit_mode ?? 'platform',
      },
      limit: {
        used: limit.currentUsage,
        // Null is unlimited, exactly as the plans table encodes it.
        max: limit.limitValue,
        reached: !limit.allowed,
        standing: limit.standing,
      },
      templates: this.templates(),
      channels: AGENT_CHANNELS,
    };
  }

  /** One agent, pinned to the account. Throws rather than returning null. */
  async findForAccount(accountId: string, agentId: string) {
    const agent = await this.prisma.ai_agents.findFirst({
      where: { id: agentId, account_id: accountId },
    });
    if (!agent) {
      throw new HttpException(
        { error: 'That agent does not exist.', code: 'agent_not_found' },
        HttpStatus.NOT_FOUND,
      );
    }
    return agent;
  }

  /**
   * Create an agent, blank or from a role template.
   *
   * ⚠️ The plan cap is checked HERE and nowhere else, so every path that
   * makes an agent — create and duplicate both — comes through this
   * method. `increment: 1` asks "may there be one more", which is the
   * question, rather than "are we at the limit", which is off by one at
   * exactly the moment it matters.
   */
  async create(args: {
    accountId: string;
    userId: string | null;
    name?: unknown;
    templateId?: unknown;
    channels?: unknown;
  }) {
    const { accountId, userId } = args;

    const check = await this.entitlement.checkLimit(accountId, 'ai_agents', 1);
    if (!check.allowed) {
      throw new HttpException(
        {
          error: this.entitlement.refusalMessage('ai_agents', check),
          code:
            check.reason === 'subscription_lapsed'
              ? 'subscription_lapsed'
              : 'agent_limit_reached',
          limit: check.limitValue,
          used: check.currentUsage,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const template =
      typeof args.templateId === 'string' && args.templateId
        ? findAgentTemplate(args.templateId)
        : undefined;

    if (typeof args.templateId === 'string' && args.templateId && !template) {
      throw new HttpException(
        { error: 'That template does not exist.', code: 'unknown_template' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const requested =
      typeof args.name === 'string' && args.name.trim()
        ? args.name.trim().slice(0, 60)
        : (template?.name ?? 'New agent');

    const name = await this.uniqueName(accountId, requested);
    const channels = this.parseChannels(args.channels);

    const agent = await this.prisma.ai_agents.create({
      data: {
        account_id: accountId,
        created_by: userId,
        name,
        channels,
        priority: await this.nextPriority(accountId),
        // Never active on creation. An agent that starts answering
        // customers the moment it is named has had no persona, no
        // knowledge and no review — and the first thing anyone would
        // know about it is a customer complaining.
        is_active: false,
        ...(template
          ? {
              tone: template.tone,
              response_length: template.responseLength,
              ground_rules: template.groundRules,
              skills: templateSkills(template) as object,
              handoff_enabled: template.handoffEnabled,
              handoff_trigger_phrases: template.handoffTriggerPhrases,
              handoff_message: template.handoffMessage,
              fallback_message: template.fallbackMessage,
            }
          : {}),
      },
    });

    return {
      agent: this.publicAgent(agent),
      template_id: template?.id ?? null,
    };
  }

  /**
   * Copy an agent, including its library selection.
   *
   * The copy is switched off and its test numbers are dropped: those
   * are a statement about one specific rollout, and inheriting them
   * would point a new agent at somebody's personal phone.
   */
  async duplicate(args: {
    accountId: string;
    agentId: string;
    userId: string | null;
  }) {
    const { accountId, agentId, userId } = args;
    const source = await this.findForAccount(accountId, agentId);

    const check = await this.entitlement.checkLimit(accountId, 'ai_agents', 1);
    if (!check.allowed) {
      throw new HttpException(
        {
          error: this.entitlement.refusalMessage('ai_agents', check),
          code:
            check.reason === 'subscription_lapsed'
              ? 'subscription_lapsed'
              : 'agent_limit_reached',
          limit: check.limitValue,
          used: check.currentUsage,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // Copy everything EXCEPT the identity, the ordering and the two
    // fields that describe one specific rollout. Subtractive rather than
    // a hand-written field list on purpose: a column added to `ai_agents`
    // later is carried by a duplicate automatically, where a list would
    // silently start dropping it.
    const NOT_COPIED = [
      'id',
      'account_id',
      'created_by',
      'created_at',
      'updated_at',
      'name',
      'priority',
      'is_active',
      'test_mode',
      'test_numbers',
    ];
    const carried = Object.fromEntries(
      Object.entries(source).filter(([key]) => !NOT_COPIED.includes(key)),
    );

    const copy = await this.prisma.ai_agents.create({
      data: {
        ...carried,
        skills: (source.skills ?? {}) as object,
        account_id: accountId,
        created_by: userId,
        name: await this.uniqueName(accountId, `${source.name} copy`),
        priority: await this.nextPriority(accountId),
        // A copy is never live, and never inherits the original's test
        // numbers: those point at one person's phone for one rollout.
        is_active: false,
        test_mode: false,
        test_numbers: [],
      },
    });

    const [docs, actions] = await Promise.all([
      this.prisma.ai_agent_knowledge.findMany({
        where: { agent_id: source.id },
        select: { document_id: true },
      }),
      this.prisma.ai_agent_action_links.findMany({
        where: { agent_id: source.id },
        select: { action_id: true },
      }),
    ]);

    if (docs.length > 0) {
      await this.prisma.ai_agent_knowledge.createMany({
        data: docs.map((d) => ({
          agent_id: copy.id,
          document_id: d.document_id,
          account_id: accountId,
        })),
        skipDuplicates: true,
      });
    }
    if (actions.length > 0) {
      await this.prisma.ai_agent_action_links.createMany({
        data: actions.map((a) => ({
          agent_id: copy.id,
          action_id: a.action_id,
          account_id: accountId,
        })),
        skipDuplicates: true,
      });
    }

    return { agent: this.publicAgent(copy) };
  }

  /**
   * Delete an agent.
   *
   * Its conversations and messages survive with `ai_agent_id` set to
   * NULL by the foreign key — the replies really were sent, and deleting
   * an agent must not delete a customer's history. What is lost is the
   * attribution, which is the honest outcome.
   */
  async remove(accountId: string, agentId: string) {
    await this.findForAccount(accountId, agentId);
    await this.prisma.ai_agents.delete({ where: { id: agentId } });
    return { success: true };
  }

  /**
   * Set the order routing tries agents in.
   *
   * Takes the WHOLE list rather than a move: with a partial update, two
   * people reordering at once produce an order neither of them chose,
   * and there is no way to tell from the rows that it happened. Ids from
   * another workspace are dropped rather than rejected — this arrives
   * from a drag-and-drop, and one stale id should not lose the reorder.
   */
  async reorder(accountId: string, agentIds: unknown) {
    const ids = Array.isArray(agentIds)
      ? agentIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (ids.length === 0) {
      throw new HttpException(
        { error: 'Send the agent ids in their new order.', code: 'no_order' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const owned = await this.prisma.ai_agents.findMany({
      where: { account_id: accountId, id: { in: ids } },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((a) => a.id));

    let priority = 1;
    const writes = ids
      .filter((id) => ownedIds.has(id))
      .map((id) =>
        this.prisma.ai_agents.update({
          where: { id },
          data: { priority: priority++ },
        }),
      );

    await this.prisma.$transaction(writes);
    return { success: true, ordered: writes.length };
  }

  /**
   * The agent as the API returns it. `skills` goes through
   * `sanitizeSkills` so a row written before a skill existed still comes
   * back with every registry key present.
   */
  publicAgent<T extends { skills: unknown }>(agent: T) {
    return { ...agent, skills: sanitizeSkills(agent.skills) };
  }

  /** Channels, validated against the ones a conversation can arrive on. */
  parseChannels(value: unknown): AgentChannel[] {
    if (!Array.isArray(value)) return [];
    const picked = value.filter((c): c is AgentChannel =>
      (AGENT_CHANNELS as readonly string[]).includes(c as string),
    );
    return Array.from(new Set(picked));
  }

  /**
   * "Sales", then "Sales 2", then "Sales 3".
   *
   * The unique index is the real guard; this exists so that duplicating
   * an agent twice is not a validation error the user has to resolve by
   * inventing a name.
   */
  private async uniqueName(accountId: string, requested: string) {
    const base = requested.trim().slice(0, 60) || 'New agent';
    const taken = new Set(
      (
        await this.prisma.ai_agents.findMany({
          where: { account_id: accountId },
          select: { name: true },
        })
      ).map((a) => a.name.trim().toLowerCase()),
    );

    if (!taken.has(base.toLowerCase())) return base;

    for (let n = 2; n < 100; n += 1) {
      const suffix = ` ${n}`;
      const candidate = `${base.slice(0, 60 - suffix.length)}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }

    return `${base.slice(0, 50)} ${Date.now().toString().slice(-6)}`;
  }

  /** New agents go to the end of the routing order, never the front. */
  private async nextPriority(accountId: string) {
    const last = await this.prisma.ai_agents.findFirst({
      where: { account_id: accountId },
      orderBy: { priority: 'desc' },
      select: { priority: true },
    });
    return (last?.priority ?? 0) + 1;
  }
}
