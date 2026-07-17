import { Injectable, Logger } from '@nestjs/common';
import type { Flow, FlowNode, FlowRun } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FlowMetaSendService } from '../../whatsapp/flow-meta-send.service';
import { decideFallback, resolveFallbackPolicy } from '../flow-fallback.util';
import {
  evaluateConditionPredicate,
  interpolateVars,
  matchReplyId,
  matchesKeywordTrigger,
} from './flow-engine-helpers.util';
import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  DispatchInboundInput,
  DispatchInboundResult,
  FlowRunEventType,
  KeywordTriggerConfig,
  ParsedInbound,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMediaNodeConfig,
  SendMessageNodeConfig,
  StartNodeConfig,
  SetTagNodeConfig,
} from '../flow.types';

/**
 * Flow runner — ported from apps/web/src/lib/flows/engine.ts
 * (`dispatchInboundToFlows` + node executors + the synchronous
 * advance loop), swapped from the Supabase service-role client to
 * PrismaService and from `meta-send.ts` to FlowMetaSendService.
 *
 * The single entry point `dispatchInbound` is called (via the
 * internal machine-to-machine bridge) by the WhatsApp webhook on
 * every inbound message. It decides whether the message belongs to
 * an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back so
 * the webhook knows whether to also fire automations.
 *
 * Concurrency model (unchanged from the original):
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 (Prisma P2002) and the runner catches & exits.
 *
 * Error semantics (also unchanged): every DB helper degrades softly —
 * a read failure logs and behaves like "not found", write failures on
 * bookkeeping columns are non-fatal — because the original's Supabase
 * client returned errors as values that were often deliberately
 * ignored. Only Meta send failures fail the run (with a matching
 * `error` event + `failed` status).
 */
@Injectable()
export class FlowDispatchService {
  private readonly logger = new Logger(FlowDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metaSend: FlowMetaSendService,
  ) {}

  // ============================================================
  // Public entry point — the webhook calls this on every inbound.
  // ============================================================

  async dispatchInbound(
    input: DispatchInboundInput,
  ): Promise<DispatchInboundResult> {
    try {
      const activeRun = await this.loadActiveRunForContact(
        input.accountId,
        input.contactId,
      );

      // Idempotency — only matters if there's already a run for this
      // contact. For new runs, the partial unique index catches duplicate
      // starts at INSERT time.
      if (activeRun) {
        const dupe = await this.isDuplicateInbound(
          input.accountId,
          input.contactId,
          input.message.meta_message_id,
        );
        if (dupe) {
          return {
            consumed: true,
            flow_run_id: activeRun.id,
            outcome: 'duplicate_inbound_ignored',
          };
        }
        // One SELECT for the whole flow's nodes — advance loop is
        // in-memory from here.
        const nodes = await this.loadAllNodes(activeRun.flowId);
        return this.handleReplyForActiveRun(activeRun, input.message, nodes);
      }

      // No active run → look for a flow whose entry trigger matches.
      const flow = await this.findEntryFlow(
        input.accountId,
        input.message,
        input.isFirstInboundMessage,
      );
      if (!flow || !flow.entryNodeId) {
        return { consumed: false, outcome: 'no_match' };
      }
      const nodes = await this.loadAllNodes(flow.id);
      return this.startNewRun(flow, input, nodes);
    } catch (err) {
      this.logger.error(
        `dispatchInbound threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { consumed: false, outcome: 'no_match' };
    }
  }

  // ============================================================
  // DB I/O — wrapped in tiny helpers so the dispatch flow stays
  // readable. Read failures degrade to "not found" (see class doc).
  // ============================================================

  private async loadActiveRunForContact(
    accountId: string,
    contactId: string,
  ): Promise<FlowRun | null> {
    // The partial unique index `idx_one_active_run_per_contact` makes
    // "two active runs for one contact in one account" impossible by
    // design — but a migration glitch or manual SQL could create one.
    // findFirst (newest) is forgiving: pick the newest, let the sweep
    // clean up the stale one.
    try {
      return await this.prisma.flowRun.findFirst({
        where: { accountId, contactId, status: 'active' },
        orderBy: { startedAt: 'desc' },
      });
    } catch (err) {
      this.logger.error(
        `loadActiveRunForContact error: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async loadFlow(flowId: string): Promise<Flow | null> {
    try {
      return await this.prisma.flow.findUnique({ where: { id: flowId } });
    } catch (err) {
      this.logger.error(`loadFlow error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Load every node of a flow in one round trip and key them by
   * `node_key`. The advance loop is then in-memory — a 5-node
   * auto-advancing chain costs one SELECT, not five.
   *
   * Returns an empty map on error so the caller can still dispatch
   * cleanly (every subsequent .get() returns undefined → the run
   * fails with node_not_found, same as a missing node).
   */
  private async loadAllNodes(flowId: string): Promise<Map<string, FlowNode>> {
    const map = new Map<string, FlowNode>();
    try {
      const rows = await this.prisma.flowNode.findMany({ where: { flowId } });
      for (const row of rows) map.set(row.nodeKey, row);
    } catch (err) {
      this.logger.error(`loadAllNodes error: ${(err as Error).message}`);
    }
    return map;
  }

  private async logEvent(
    flowRunId: string,
    eventType: FlowRunEventType,
    nodeKey: string | null,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.prisma.flowRunEvent.create({
        data: {
          flowRunId,
          eventType,
          nodeKey,
          payload: payload as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Logging failure is non-fatal — surface but don't throw.
      this.logger.error(`logEvent error: ${(err as Error).message}`);
    }
  }

  /**
   * Idempotency check — has a `reply_received` event with this Meta
   * message_id already been recorded for any of the contact's flow
   * runs? If yes, the inbound is a duplicate (Meta retry) and we exit
   * without re-advancing. The functional index
   * `idx_flow_run_events_meta_message_id` on
   * `(payload->>'meta_message_id')` keeps the scan O(1).
   */
  private async isDuplicateInbound(
    accountId: string,
    contactId: string,
    metaMessageId: string,
  ): Promise<boolean> {
    try {
      const hit = await this.prisma.flowRunEvent.findFirst({
        where: {
          eventType: 'reply_received',
          payload: { path: ['meta_message_id'], equals: metaMessageId },
          flowRun: { accountId, contactId },
        },
        select: { id: true },
      });
      return hit !== null;
    } catch (err) {
      // Non-fatal — log and let the dispatch continue. A failed check
      // means we might re-advance on a Meta retry, but that's better
      // than silently dropping the message.
      this.logger.error(
        `isDuplicateInbound check failed: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async findEntryFlow(
    accountId: string,
    message: ParsedInbound,
    isFirstInbound: boolean,
  ): Promise<Flow | null> {
    // Only text messages can match an entry trigger. Interactive replies
    // are responses to existing prompts; they never start a new flow.
    if (message.kind !== 'text') return null;

    let flows: Flow[];
    try {
      flows = await this.prisma.flow.findMany({
        where: { accountId, status: 'active' },
        orderBy: { createdAt: 'asc' },
      });
    } catch {
      return null;
    }

    for (const flow of flows) {
      if (flow.triggerType === 'keyword') {
        if (
          matchesKeywordTrigger(
            message.text,
            flow.triggerConfig as unknown as KeywordTriggerConfig,
          )
        ) {
          return flow;
        }
      } else if (
        flow.triggerType === 'first_inbound_message' &&
        isFirstInbound
      ) {
        return flow;
      }
      // 'manual' triggers do not auto-start from inbound messages.
    }
    return null;
  }

  // ============================================================
  // Node executors — each handles ONE node type. send_buttons and
  // send_list also persist `last_prompt_message_id` so the inbox
  // thread can quote the prompt the customer is replying to.
  // ============================================================

  private async sendButtonsAndSuspend(
    run: FlowRun,
    node: FlowNode,
  ): Promise<void> {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const { whatsapp_message_id } = await this.metaSend.sendInteractiveButtons({
      accountId: run.accountId,
      conversationId: run.conversationId!,
      contactId: run.contactId!,
      bodyText: cfg.text,
      headerText: cfg.header_text,
      footerText: cfg.footer_text,
      buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
    });
    await this.logEvent(run.id, 'message_sent', node.nodeKey, {
      node_type: 'send_buttons',
      whatsapp_message_id,
    });
    await this.stashLastPromptMessageId(run.id, whatsapp_message_id);
  }

  private async sendListAndSuspend(
    run: FlowRun,
    node: FlowNode,
  ): Promise<void> {
    const cfg = node.config as unknown as SendListNodeConfig;
    const { whatsapp_message_id } = await this.metaSend.sendInteractiveList({
      accountId: run.accountId,
      conversationId: run.conversationId!,
      contactId: run.contactId!,
      bodyText: cfg.text,
      buttonLabel: cfg.button_label,
      headerText: cfg.header_text,
      footerText: cfg.footer_text,
      sections: cfg.sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({
          id: r.reply_id,
          title: r.title,
          description: r.description,
        })),
      })),
    });
    await this.logEvent(run.id, 'message_sent', node.nodeKey, {
      node_type: 'send_list',
      whatsapp_message_id,
    });
    await this.stashLastPromptMessageId(run.id, whatsapp_message_id);
  }

  /**
   * Look up our internal message id for a just-sent Meta message and
   * stash it on the run. Cheap — indexed on `messages.message_id`.
   * Non-fatal on failure (bookkeeping only), matching the original.
   */
  private async stashLastPromptMessageId(
    runId: string,
    whatsappMessageId: string,
  ): Promise<void> {
    try {
      const msg = await this.prisma.messages.findFirst({
        where: { message_id: whatsappMessageId },
        select: { id: true },
      });
      await this.prisma.flowRun.update({
        where: { id: runId },
        data: { lastPromptMessageId: msg?.id ?? null },
      });
    } catch (err) {
      this.logger.error(
        `stashLastPromptMessageId error: ${(err as Error).message}`,
      );
    }
  }

  private async executeHandoff(run: FlowRun, node: FlowNode): Promise<void> {
    const cfg = node.config as { assign_to?: string; note?: string };
    if (run.conversationId) {
      try {
        await this.prisma.conversations.update({
          where: { id: run.conversationId },
          data: {
            status: 'pending',
            updated_at: new Date(),
            ...(cfg.assign_to ? { assigned_agent_id: cfg.assign_to } : {}),
          },
        });
      } catch (err) {
        this.logger.error(
          `handoff conversation update failed: ${(err as Error).message}`,
        );
      }
    }
    await this.logEvent(run.id, 'handoff', node.nodeKey, {
      note: cfg.note ?? null,
      assigned_to: cfg.assign_to ?? null,
    });
    await this.endRun(run.id, 'handed_off', 'handoff_node');
  }

  /**
   * Resolve a condition node's subject value from DB / run state, then
   * call the pure `evaluateConditionPredicate`.
   *
   * Subject sources:
   *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input).
   *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
   *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
   *   - `contact_field` → one of name/email/phone/company on `contacts`.
   */
  private async evaluateConditionNode(
    run: FlowRun,
    cfg: ConditionNodeConfig,
    vars: Record<string, unknown>,
  ): Promise<boolean> {
    let subjectValue: string | undefined;
    if (cfg.subject === 'var') {
      const v = vars[cfg.subject_key];
      subjectValue =
        typeof v === 'string'
          ? v
          : v === undefined
            ? undefined
            : String(v as number | boolean);
    } else if (cfg.subject === 'tag') {
      let count = 0;
      try {
        count = await this.prisma.contact_tags.count({
          where: { contact_id: run.contactId!, tag_id: cfg.subject_key },
        });
      } catch {
        count = 0;
      }
      subjectValue = count > 0 ? cfg.subject_key : undefined;
    } else {
      const ALLOWED = ['name', 'email', 'phone', 'company'] as const;
      type AllowedField = (typeof ALLOWED)[number];
      if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
        throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
      }
      let raw: unknown;
      try {
        const contact = await this.prisma.contacts.findUnique({
          where: { id: run.contactId! },
          select: { name: true, email: true, phone: true, company: true },
        });
        raw = (contact as Record<string, unknown> | null)?.[cfg.subject_key];
      } catch {
        raw = undefined;
      }
      subjectValue =
        typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    }
    return evaluateConditionPredicate({
      operator: cfg.operator,
      subjectValue,
      configValue: cfg.value,
    });
  }

  private async endRun(
    runId: string,
    status: 'completed' | 'handed_off' | 'timed_out' | 'failed',
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.flowRun.update({
        where: { id: runId },
        data: { status, endedAt: new Date(), endReason: reason },
      });
    } catch (err) {
      this.logger.error(`endRun error: ${(err as Error).message}`);
    }
  }

  // ============================================================
  // The synchronous advance loop. Walks through auto-advance nodes
  // until it hits one that suspends (send_buttons/send_list/
  // collect_input) or terminates (handoff/end). Each suspending node
  // persists the new current_node_key before returning.
  // ============================================================

  private async advanceFromNodeKey(
    run: FlowRun,
    startNodeKey: string,
    nodes: Map<string, FlowNode>,
    vars: Record<string, unknown>,
  ): Promise<{ outcome: 'advanced' | 'completed' | 'handed_off' }> {
    let currentKey: string | null = startNodeKey;
    // Defensive cap — if a flow has a cycle (which the validator
    // SHOULD catch but doesn't yet in v1), we bail rather than loop.
    for (let safety = 0; safety < 64; safety += 1) {
      if (!currentKey) {
        await this.logEvent(run.id, 'error', null, {
          reason: 'next_node_key was null mid-advance',
        });
        await this.endRun(run.id, 'failed', 'missing_next_node');
        return { outcome: 'completed' };
      }
      const node: FlowNode | null = nodes.get(currentKey) ?? null;
      if (!node) {
        await this.logEvent(run.id, 'error', currentKey, {
          reason: 'node_not_found',
        });
        await this.endRun(run.id, 'failed', 'node_not_found');
        return { outcome: 'completed' };
      }
      await this.logEvent(run.id, 'node_entered', node.nodeKey, {
        node_type: node.nodeType,
      });

      if (node.nodeType === 'start') {
        currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
        continue;
      }
      if (node.nodeType === 'send_message') {
        const cfg = node.config as unknown as SendMessageNodeConfig;
        try {
          const { whatsapp_message_id } = await this.metaSend.sendText({
            accountId: run.accountId,
            conversationId: run.conversationId!,
            contactId: run.contactId!,
            text: interpolateVars(cfg.text, vars),
          });
          await this.logEvent(run.id, 'message_sent', node.nodeKey, {
            node_type: 'send_message',
            whatsapp_message_id,
          });
        } catch (err) {
          await this.logEvent(run.id, 'error', node.nodeKey, {
            reason: 'send_text_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
          await this.endRun(run.id, 'failed', 'send_text_failed');
          return { outcome: 'completed' };
        }
        currentKey = cfg.next_node_key;
        continue;
      }
      if (node.nodeType === 'send_media') {
        const cfg = node.config as unknown as SendMediaNodeConfig;
        try {
          const { whatsapp_message_id } = await this.metaSend.sendMedia({
            accountId: run.accountId,
            conversationId: run.conversationId!,
            contactId: run.contactId!,
            kind: cfg.media_type,
            link: cfg.media_url,
            caption: cfg.caption
              ? interpolateVars(cfg.caption, vars)
              : undefined,
            filename: cfg.filename,
          });
          await this.logEvent(run.id, 'message_sent', node.nodeKey, {
            node_type: 'send_media',
            media_type: cfg.media_type,
            whatsapp_message_id,
          });
        } catch (err) {
          await this.logEvent(run.id, 'error', node.nodeKey, {
            reason: 'send_media_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
          await this.endRun(run.id, 'failed', 'send_media_failed');
          return { outcome: 'completed' };
        }
        currentKey = cfg.next_node_key;
        continue;
      }
      if (node.nodeType === 'collect_input') {
        // Send the prompt and suspend. Customer's next TEXT reply will
        // wake us up via handleReplyForActiveRun's collect_input branch.
        const cfg = node.config as unknown as CollectInputNodeConfig;
        try {
          const { whatsapp_message_id } = await this.metaSend.sendText({
            accountId: run.accountId,
            conversationId: run.conversationId!,
            contactId: run.contactId!,
            text: interpolateVars(cfg.prompt_text, vars),
          });
          await this.logEvent(run.id, 'message_sent', node.nodeKey, {
            node_type: 'collect_input',
            whatsapp_message_id,
          });
          const msg = await this.prisma.messages.findFirst({
            where: { message_id: whatsapp_message_id },
            select: { id: true },
          });
          await this.prisma.flowRun.update({
            where: { id: run.id },
            data: { lastPromptMessageId: msg?.id ?? null },
          });
        } catch (err) {
          await this.logEvent(run.id, 'error', node.nodeKey, {
            reason: 'collect_input_prompt_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
          await this.endRun(run.id, 'failed', 'collect_input_prompt_failed');
          return { outcome: 'completed' };
        }
        const advanced = await this.advanceCurrentNodeKey(
          run.id,
          run.currentNodeKey,
          node.nodeKey,
        );
        if (!advanced) {
          await this.logEvent(run.id, 'error', node.nodeKey, {
            reason: 'lost_race_during_advance',
          });
        }
        return { outcome: 'advanced' };
      }
      if (node.nodeType === 'condition') {
        const cfg = node.config as unknown as ConditionNodeConfig;
        let branch: 'true' | 'false';
        try {
          branch = (await this.evaluateConditionNode(run, cfg, vars))
            ? 'true'
            : 'false';
        } catch (err) {
          await this.logEvent(run.id, 'error', node.nodeKey, {
            reason: 'condition_evaluation_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
          await this.endRun(run.id, 'failed', 'condition_evaluation_failed');
          return { outcome: 'completed' };
        }
        currentKey = branch === 'true' ? cfg.true_next : cfg.false_next;
        await this.logEvent(run.id, 'node_entered', node.nodeKey, {
          condition_result: branch,
          advancing_to: currentKey,
        });
        continue;
      }
      if (node.nodeType === 'set_tag') {
        const cfg = node.config as unknown as SetTagNodeConfig;
        try {
          if (cfg.mode === 'add') {
            await this.prisma.contact_tags.upsert({
              where: {
                contact_id_tag_id: {
                  contact_id: run.contactId!,
                  tag_id: cfg.tag_id,
                },
              },
              create: { contact_id: run.contactId!, tag_id: cfg.tag_id },
              update: {},
            });
          } else {
            await this.prisma.contact_tags.deleteMany({
              where: { contact_id: run.contactId!, tag_id: cfg.tag_id },
            });
          }
        } catch (err) {
          // Non-fatal — log + advance. A tag-write failure shouldn't
          // strand the customer mid-flow.
          await this.logEvent(run.id, 'error', node.nodeKey, {
            reason: 'set_tag_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        currentKey = cfg.next_node_key;
        continue;
      }
      if (node.nodeType === 'send_buttons') {
        await this.sendButtonsAndSuspend(run, node);
        // Persist the new current_node_key via optimistic UPDATE.
        const advanced = await this.advanceCurrentNodeKey(
          run.id,
          run.currentNodeKey,
          node.nodeKey,
        );
        if (!advanced) {
          await this.logEvent(run.id, 'error', node.nodeKey, {
            reason: 'lost_race_during_advance',
          });
        }
        return { outcome: 'advanced' };
      }
      if (node.nodeType === 'send_list') {
        await this.sendListAndSuspend(run, node);
        const advanced = await this.advanceCurrentNodeKey(
          run.id,
          run.currentNodeKey,
          node.nodeKey,
        );
        if (!advanced) {
          await this.logEvent(run.id, 'error', node.nodeKey, {
            reason: 'lost_race_during_advance',
          });
        }
        return { outcome: 'advanced' };
      }
      if (node.nodeType === 'handoff') {
        await this.executeHandoff(run, node);
        return { outcome: 'handed_off' };
      }
      if (node.nodeType === 'end') {
        await this.logEvent(run.id, 'completed', node.nodeKey);
        await this.endRun(run.id, 'completed', 'end_node');
        return { outcome: 'completed' };
      }
      // Unknown node type — shouldn't happen given the CHECK constraint.
      await this.logEvent(run.id, 'error', node.nodeKey, {
        reason: `unknown_node_type:${node.nodeType}`,
      });
      await this.endRun(run.id, 'failed', 'unknown_node_type');
      return { outcome: 'completed' };
    }
    // Safety break — log + fail.
    await this.logEvent(run.id, 'error', currentKey, {
      reason: 'advance_loop_safety_break',
    });
    await this.endRun(run.id, 'failed', 'advance_loop_overflow');
    return { outcome: 'completed' };
  }

  /**
   * Optimistic UPDATE — only advance current_node_key when it matches
   * the value we read at the top of dispatch. If another webhook beat
   * us, the row's pointer has already moved and our UPDATE returns
   * zero rows; we treat that as a no-op and let the other run continue.
   *
   * Prisma's `updateMany` with `currentNodeKey: null` compiles to
   * `IS NULL`, so the PostgREST `.is()` special case isn't needed.
   */
  private async advanceCurrentNodeKey(
    runId: string,
    expectedOldKey: string | null,
    newKey: string,
  ): Promise<boolean> {
    try {
      const result = await this.prisma.flowRun.updateMany({
        where: {
          id: runId,
          status: 'active',
          currentNodeKey: expectedOldKey,
        },
        data: { currentNodeKey: newKey, lastAdvancedAt: new Date() },
      });
      return result.count > 0;
    } catch (err) {
      this.logger.error(
        `advanceCurrentNodeKey error: ${(err as Error).message}`,
      );
      return false;
    }
  }

  // ============================================================
  // Reply handling + run start
  // ============================================================

  private async handleReplyForActiveRun(
    run: FlowRun,
    message: ParsedInbound,
    nodes: Map<string, FlowNode>,
  ): Promise<DispatchInboundResult> {
    // Mirror the run's mutable state locally — the capture branch below
    // updates vars/reprompt_count in the DB and these locals together,
    // so downstream interpolation sees the captured var without a
    // re-SELECT of the whole row.
    let vars = (run.vars ?? {}) as Record<string, unknown>;
    let repromptCount = run.repromptCount;

    // Note: we intentionally do NOT persist the raw customer text. A
    // `collect_input` prompt that asks "what's your card number?" would
    // otherwise leave the PAN sitting in flow_run_events.payload forever,
    // visible to anyone with access to the runs viewer or the events
    // table. Length is enough for "did they actually reply?" debugging.
    await this.logEvent(run.id, 'reply_received', run.currentNodeKey, {
      meta_message_id: message.meta_message_id,
      reply_kind: message.kind,
      reply_id: message.kind === 'interactive_reply' ? message.reply_id : null,
      text_length: message.kind === 'text' ? message.text.length : null,
    });

    if (!run.currentNodeKey) {
      // Defensive — a run with status='active' but no current node is
      // malformed. Fail the run rather than spin.
      await this.endRun(run.id, 'failed', 'active_run_missing_current_node');
      return { consumed: true, flow_run_id: run.id, outcome: 'no_match' };
    }

    const currentNode = nodes.get(run.currentNodeKey) ?? null;
    if (!currentNode) {
      await this.endRun(run.id, 'failed', 'current_node_not_found');
      return { consumed: true, flow_run_id: run.id, outcome: 'no_match' };
    }

    // Two ways a reply can advance:
    //   1. Interactive button/list tap on a send_buttons/send_list node.
    //   2. Text reply on a collect_input node — capture into vars.
    //
    // Everything else falls through to the fallback policy below.
    let matched: string | null = null;
    if (
      message.kind === 'interactive_reply' &&
      (currentNode.nodeType === 'send_buttons' ||
        currentNode.nodeType === 'send_list')
    ) {
      matched = matchReplyId(
        {
          node_type: currentNode.nodeType,
          config: currentNode.config as Record<string, unknown>,
        },
        message.reply_id,
      );
    } else if (
      message.kind === 'text' &&
      currentNode.nodeType === 'collect_input'
    ) {
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      const captured = message.text.trim();
      if (captured.length > 0 && cfg.var_key) {
        // Persist captured value + reset reprompt count atomically.
        const newVars = { ...vars, [cfg.var_key]: captured };
        try {
          await this.prisma.flowRun.update({
            where: { id: run.id },
            data: {
              vars: newVars as Prisma.InputJsonValue,
              repromptCount: 0,
            },
          });
          vars = newVars;
          repromptCount = 0;
          await this.logEvent(run.id, 'node_entered', currentNode.nodeKey, {
            captured_key: cfg.var_key,
            captured_length: captured.length,
          });
          matched = cfg.next_node_key;
        } catch (err) {
          // Capture write failed — fall through to the fallback path,
          // matching the original's capErr handling.
          this.logger.error(
            `collect_input capture failed: ${(err as Error).message}`,
          );
        }
      }
    }

    if (matched) {
      // Reset reprompt count on a successful match. Skip the write when
      // already 0 — the collect_input capture branch above already
      // zeroed it, and interactive-reply matches against a fresh run
      // (post-prior-reset) are also already 0.
      if (repromptCount !== 0) {
        try {
          await this.prisma.flowRun.update({
            where: { id: run.id },
            data: { repromptCount: 0 },
          });
          repromptCount = 0;
        } catch (err) {
          this.logger.error(
            `reprompt_count reset failed: ${(err as Error).message}`,
          );
        }
      }
      const outcome = await this.advanceFromNodeKey(run, matched, nodes, vars);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }

    // No match → fallback. Apply the policy.
    const policy = resolveFallbackPolicy(
      (await this.loadFlow(run.flowId))?.fallbackPolicy,
    );
    const newReprompts = repromptCount + 1;
    try {
      await this.prisma.flowRun.update({
        where: { id: run.id },
        data: { repromptCount: newReprompts },
      });
    } catch (err) {
      this.logger.error(
        `reprompt_count bump failed: ${(err as Error).message}`,
      );
    }

    const action = decideFallback({ policy, reprompt_count: newReprompts });
    await this.logEvent(run.id, 'fallback_fired', run.currentNodeKey, {
      action: action.type,
      reprompt_count: newReprompts,
    });
    if (action.type === 'ignore') {
      // Don't consume — let automations have a shot at it.
      return { consumed: false, flow_run_id: run.id, outcome: 'no_match' };
    }
    if (action.type === 'reprompt') {
      // Re-send the same prompt. Same node, no current_node_key change.
      if (currentNode.nodeType === 'send_buttons') {
        await this.sendButtonsAndSuspend(run, currentNode);
      } else if (currentNode.nodeType === 'send_list') {
        await this.sendListAndSuspend(run, currentNode);
      } else if (currentNode.nodeType === 'collect_input') {
        // Customer typed something we couldn't accept (empty after trim,
        // or var_key missing — rare). Re-send the prompt so they try again.
        const cfg = currentNode.config as unknown as CollectInputNodeConfig;
        try {
          await this.metaSend.sendText({
            accountId: run.accountId,
            conversationId: run.conversationId!,
            contactId: run.contactId!,
            text: interpolateVars(cfg.prompt_text, vars),
          });
        } catch (err) {
          await this.logEvent(run.id, 'error', currentNode.nodeKey, {
            reason: 'reprompt_send_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return {
        consumed: true,
        flow_run_id: run.id,
        outcome: 'fallback_fired',
      };
    }
    if (action.type === 'handoff') {
      if (run.conversationId) {
        try {
          await this.prisma.conversations.update({
            where: { id: run.conversationId },
            data: { status: 'pending', updated_at: new Date() },
          });
        } catch (err) {
          this.logger.error(
            `fallback handoff conversation update failed: ${(err as Error).message}`,
          );
        }
      }
      await this.logEvent(run.id, 'handoff', run.currentNodeKey, {
        reason: 'fallback_exhausted',
      });
      await this.endRun(run.id, 'handed_off', 'fallback_exhausted');
      return { consumed: true, flow_run_id: run.id, outcome: 'handed_off' };
    }
    // action.type === 'end'
    await this.endRun(run.id, 'completed', 'fallback_exhausted_end');
    return { consumed: true, flow_run_id: run.id, outcome: 'completed' };
  }

  private async startNewRun(
    flow: Flow,
    input: DispatchInboundInput,
    nodes: Map<string, FlowNode>,
  ): Promise<DispatchInboundResult> {
    // INSERT — partial unique index `idx_one_active_run_per_contact`
    // catches concurrent inserts with 23505 (Prisma P2002). We catch
    // and return as consumed:true (the parallel webhook handles it).
    let run: FlowRun;
    try {
      run = await this.prisma.flowRun.create({
        data: {
          flowId: flow.id,
          // Tenancy: the partial unique index is over (account_id,
          // contact_id) WHERE status='active', so two accounts sharing
          // a contact phone number each run their own flows independently.
          accountId: flow.accountId,
          // Audit: preserves the flow's author on the run row for log
          // attribution.
          userId: flow.userId,
          contactId: input.contactId,
          conversationId: input.conversationId,
          status: 'active',
          currentNodeKey: flow.entryNodeId,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // unique_violation → another webhook is starting the run.
        return { consumed: true, outcome: 'duplicate_inbound_ignored' };
      }
      this.logger.error(
        `startNewRun insert error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { consumed: false, outcome: 'no_match' };
    }

    await this.logEvent(run.id, 'started', flow.entryNodeId, {
      flow_id: flow.id,
      trigger_type: flow.triggerType,
      meta_message_id: input.message.meta_message_id,
    });

    // Bump the flow's execution counter — used by the builder UI to
    // surface "X runs since activation" on the flow card.
    //
    // The original called the `increment_flow_execution_count` RPC
    // (migration 012) to avoid a lost-update between two concurrent
    // read-modify-write dispatches; Prisma's atomic `{ increment: 1 }`
    // compiles to the same single UPDATE the RPC ran, so the RPC isn't
    // needed here (matches the automations port's executionCount).
    try {
      await this.prisma.flow.update({
        where: { id: flow.id },
        data: { executionCount: { increment: 1 }, lastExecutedAt: new Date() },
      });
    } catch (err) {
      // Non-fatal — the run itself succeeded; only the counter is off.
      this.logger.error(
        `execution_count increment error: ${(err as Error).message}`,
      );
    }

    // Run the advance loop starting from the entry node.
    const outcome = await this.advanceFromNodeKey(
      run,
      flow.entryNodeId!,
      nodes,
      (run.vars ?? {}) as Record<string, unknown>,
    );
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome === 'advanced' ? 'started' : outcome.outcome,
    };
  }
}
