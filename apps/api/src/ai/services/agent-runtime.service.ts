import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import { buildSystemPrompt } from '../lib/defaults';
import { retrieveKnowledge } from '../lib/knowledge';
import { latestUserMessage } from '../lib/query';
import { enabledSkillTools } from '../lib/skills';
import {
  actionToolDefinition,
  parseActionParameters,
  runAction,
  type AgentAction,
} from '../lib/tools/actions';
import {
  BUILTIN_TOOLS,
  builtinToolsByName,
  type BuiltinToolContext,
} from '../lib/tools/builtin';
import type { ToolExecutor } from '../lib/generate';
import type {
  AiConfig,
  ChatMessage,
  KnowledgeHit,
  ToolDefinition,
} from '../lib/types';

export interface RuntimeContext {
  accountId: string;
  /** The customer in the conversation; null in the playground. */
  contactId: string | null;
  /** Who writes are attributed to (contact notes need a user). */
  actorUserId: string | null;
  mode: 'draft' | 'auto_reply';
}

export interface AssembledRun {
  systemPrompt: string;
  tools: ToolDefinition[];
  executeTool: ToolExecutor;
  knowledge: KnowledgeHit[];
}

/**
 * ============================================================
 * Assembles one agent run: retrieve knowledge, gather the tools the
 * enabled skills and saved actions permit, compose the system prompt,
 * and hand back an executor bound to this account.
 *
 * WHY A SERVICE AND NOT A FUNCTION IN lib/
 *   Because it needs Prisma, and because all three entry points (inbox
 *   draft, playground, auto-reply bot) must assemble a run IDENTICALLY.
 *   The playground is only trustworthy as a test surface if it is the
 *   same assembly the customer-facing bot uses — every divergence here
 *   is a bug a user finds in production after "it worked in the test
 *   panel".
 * ============================================================
 */
@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Load the enabled custom actions this agent may call, headers
   * decrypted.
   *
   * `actionIds` is the agent's own selection (migration 084): null means
   * every action in the workspace, and an empty array means none — the
   * same distinction `knowledgeDocumentIds` draws, and for the same
   * reason. Scoping matters more here than for knowledge: an action is a
   * live HTTP call somebody configured, and a support agent should not
   * be able to reach the endpoint that issues refunds.
   */
  async loadActions(
    accountId: string,
    actionIds: string[] | null = null,
  ): Promise<AgentAction[]> {
    if (actionIds && actionIds.length === 0) return [];

    const rows = await this.prisma.ai_agent_actions.findMany({
      where: {
        account_id: accountId,
        enabled: true,
        ...(actionIds ? { id: { in: actionIds } } : {}),
      },
      orderBy: { created_at: 'asc' },
      // A model handed 40 tools picks badly and every definition costs
      // prompt tokens on the account's own bill.
      take: 20,
    });

    const actions: AgentAction[] = [];
    for (const row of rows) {
      let headers: Record<string, string> = {};
      if (row.headers_enc) {
        try {
          const parsed = JSON.parse(decrypt(row.headers_enc)) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            headers = Object.fromEntries(
              Object.entries(parsed as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => [k, v as string]),
            );
          }
        } catch {
          // An undecryptable header set means the ENCRYPTION_KEY changed.
          // Skip the action rather than calling the endpoint unauthenticated
          // — a half-authenticated request is worse than no request.
          this.logger.error(
            `[agent actions] headers for action ${row.id} could not be decrypted — action skipped.`,
          );
          continue;
        }
      }

      actions.push({
        id: row.id,
        name: row.name,
        description: row.description,
        method: row.method,
        url: row.url,
        headers,
        parameters: parseActionParameters(row.parameters),
        timeoutMs: row.timeout_ms,
      });
    }

    return actions;
  }

  /**
   * Build the tool list and a single executor that routes a call to the
   * right implementation. The executor closes over the account and
   * contact, so a model cannot address another tenant's data no matter
   * what it puts in its arguments.
   */
  private buildToolset(args: {
    config: AiConfig;
    ctx: RuntimeContext;
    actions: AgentAction[];
  }): { tools: ToolDefinition[]; executeTool: ToolExecutor } {
    const { config, ctx, actions } = args;

    const builtinNames = enabledSkillTools(config.skills);
    const builtins = builtinToolsByName(builtinNames);

    const toolContext: BuiltinToolContext = {
      prisma: this.prisma,
      accountId: ctx.accountId,
      contactId: ctx.contactId,
      actorUserId: ctx.actorUserId,
      currency: config.profile.storeCurrency,
    };

    const actionByName = new Map<string, AgentAction>();
    for (const action of actions) {
      // A custom action must not shadow a built-in: the built-in is the
      // one the skill prompt tells the model about, and silently
      // rerouting it to an arbitrary URL would be a confused-deputy bug.
      if (BUILTIN_TOOLS[action.name]) continue;
      actionByName.set(action.name, action);
    }

    const tools: ToolDefinition[] = [
      ...builtins.map((t) => t.definition),
      ...Array.from(actionByName.values()).map(actionToolDefinition),
    ];

    const executeTool: ToolExecutor = async (call) => {
      const builtin = builtinNames.includes(call.name)
        ? BUILTIN_TOOLS[call.name]
        : undefined;
      if (builtin) {
        try {
          return await builtin.run(call.arguments, toolContext);
        } catch (err) {
          this.logger.error(`[agent tool] ${call.name} failed: ${err}`);
          return {
            ok: false,
            detail:
              'That lookup failed. Do not guess the answer — say you could not check and offer to have someone follow up.',
          };
        }
      }

      const action = actionByName.get(call.name);
      if (!action) {
        return {
          ok: false,
          detail: `There is no tool called "${call.name}". Answer without it.`,
        };
      }

      const result = await runAction(action, call.arguments);

      // Best-effort telemetry so the Actions screen can show whether an
      // action actually works in production. Never blocks the reply.
      void this.prisma.ai_agent_actions
        .update({
          where: { id: action.id },
          data: {
            last_used_at: new Date(),
            last_status: result.status,
            last_error: result.ok ? null : result.detail.slice(0, 1000),
          },
        })
        .catch(() => undefined);

      return { ok: result.ok, detail: result.detail };
    };

    return { tools, executeTool };
  }

  /**
   * Retrieve knowledge, assemble tools and compose the prompt for one
   * reply. `messages` is the transcript so far — the last customer turn
   * is what knowledge is retrieved for.
   */
  async assemble(args: {
    config: AiConfig;
    messages: ChatMessage[];
    ctx: RuntimeContext;
  }): Promise<AssembledRun> {
    const { config, messages, ctx } = args;

    const [knowledge, actions] = await Promise.all([
      retrieveKnowledge(
        this.prisma,
        ctx.accountId,
        config,
        latestUserMessage(messages),
      ),
      this.loadActions(ctx.accountId, config.actionIds ?? null),
    ]);

    const { tools, executeTool } = this.buildToolset({ config, ctx, actions });

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: ctx.mode,
      knowledge,
      profile: config.profile,
      voice: config.voice,
      escalation: config.escalation,
      skills: config.skills,
      toolNames: tools.map((t) => t.name),
    });

    return { systemPrompt, tools, executeTool, knowledge };
  }
}
