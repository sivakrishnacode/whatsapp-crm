import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationMetaSendService } from '../../whatsapp/automation-meta-send.service';
import {
  ChannelSenderService,
  UnsupportedOnChannelError,
} from '../../common/messaging/channel-sender.service';
import { isDeliverableUrl } from '../../common/security/ssrf.util';
import { AutomationConditionService } from './automation-condition.service';
import { interpolate } from './automation-interpolation.util';
import type {
  AssignConversationStepConfig,
  AutomationLogStepResult,
  AutomationStepType,
  ConditionStepConfig,
  CreateDealStepConfig,
  SendMessageStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  StepExecutionArgs,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
} from '../automation.types';

export const AUTOMATIONS_PENDING_QUEUE = 'automations-pending';

/**
 * Ported from apps/web/src/lib/automations/engine.ts's `executeStepsFrom()`
 * + `runStep()`. Shared by AutomationDispatchService (fresh executions)
 * and AutomationsProcessor (BullMQ wait-step resume) via DI — the exact
 * same recursive interpreter runs both paths.
 */
@Injectable()
export class AutomationStepExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly condition: AutomationConditionService,
    /** WhatsApp-only paths (templates). Plain sends go via channelSender. */
    private readonly metaSend: AutomationMetaSendService,
    private readonly channelSender: ChannelSenderService,
    @InjectQueue(AUTOMATIONS_PENDING_QUEUE) private readonly queue: Queue,
  ) {}

  async executeStepsFrom(args: StepExecutionArgs): Promise<void> {
    const steps = await this.prisma.automationStep.findMany({
      where: {
        automationId: args.automation.id,
        position: { gte: args.startPosition },
        ...(args.parentStepId === null
          ? { parentStepId: null }
          : { parentStepId: args.parentStepId, branch: args.branch ?? 'yes' }),
      },
      orderBy: { position: 'asc' },
    });

    if (steps.length === 0) {
      if (args.parentStepId === null && args.logId) {
        await this.finalizeLog(args.logId, 'success', null);
      }
      return;
    }

    const results: AutomationLogStepResult[] = [];
    let status: 'success' | 'partial' | 'failed' = 'success';
    let errorMessage: string | null = null;

    for (const step of steps) {
      // `wait` is the suspension point: enqueue and stop processing this
      // scope. The BullMQ processor picks it up later.
      if (step.stepType === 'wait') {
        const cfg = step.stepConfig as unknown as WaitStepConfig;
        const ms = this.waitMs(cfg);
        const pending = await this.prisma.automationPendingExecution.create({
          data: {
            automationId: args.automation.id,
            accountId: args.automation.accountId,
            userId: args.automation.userId,
            contactId: args.contactId,
            logId: args.logId,
            parentStepId: args.parentStepId,
            branch: args.branch,
            nextStepPosition: step.position + 1,
            context: (args.context ?? {}) as Prisma.InputJsonValue,
            runAt: new Date(Date.now() + ms),
            status: 'pending',
          },
        });
        await this.queue.add(
          'resume-wait',
          { pendingExecutionId: pending.id },
          {
            delay: ms,
            jobId: pending.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
          },
        );
        results.push({
          step_id: step.id,
          step_type: step.stepType as AutomationStepType,
          status: 'success',
          detail: `waiting ${cfg.amount} ${cfg.unit}`,
        });
        status = 'partial';
        await this.appendResults(args.logId, results, status, errorMessage);
        return;
      }

      try {
        if (step.stepType === 'condition') {
          const cfg = step.stepConfig as unknown as ConditionStepConfig;
          const taken = await this.condition.evaluate(cfg, args);
          results.push({
            step_id: step.id,
            step_type: 'condition',
            status: 'success',
            detail: `branch=${taken ? 'yes' : 'no'}`,
          });
          // Recurse into the chosen branch at position 0 (children use
          // their own ordering within the branch scope).
          await this.executeStepsFrom({
            ...args,
            parentStepId: step.id,
            branch: taken ? 'yes' : 'no',
            startPosition: 0,
            logId: args.logId,
          });
          continue;
        }

        const detail = await this.runStep(step, args);
        results.push({
          step_id: step.id,
          step_type: step.stepType as AutomationStepType,
          status: 'success',
          detail,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // A step the channel simply cannot do is SKIPPED, not failed.
        //
        // A shared automation may legitimately contain a WhatsApp
        // template step and still be useful on Instagram — tag the
        // contact, create the deal, notify the team. Treating the
        // template as a fatal error aborted the loop and silently
        // dropped every step after it, which is how a rule that
        // "works on WhatsApp" quietly does half its job on Instagram.
        //
        // The run continues and ends 'partial', so the log shows both
        // what was skipped and why.
        if (err instanceof UnsupportedOnChannelError) {
          results.push({
            step_id: step.id,
            step_type: step.stepType as AutomationStepType,
            status: 'skipped',
            detail: msg,
          });
          if (status === 'success') status = 'partial';
          continue;
        }

        results.push({
          step_id: step.id,
          step_type: step.stepType as AutomationStepType,
          status: 'failed',
          detail: msg,
        });
        status = 'failed';
        errorMessage = msg;
        break;
      }
    }

    if (args.parentStepId === null) {
      await this.appendResults(args.logId, results, status, errorMessage);
    } else {
      // Nested branch — just append results; parent scope decides final status.
      await this.appendResults(args.logId, results, null, errorMessage);
    }
  }

  private async runStep(
    step: {
      id: string;
      stepType: string;
      stepConfig: unknown;
      position: number;
    },
    args: StepExecutionArgs,
  ): Promise<string> {
    switch (step.stepType) {
      case 'send_message': {
        const cfg = step.stepConfig as SendMessageStepConfig;
        if (!args.contactId) throw new Error('send_message needs a contact');
        const text = interpolate(cfg.text, args.context);
        if (!text.trim()) throw new Error('send_message has empty text');
        const conversationId = await this.resolveConversationId(args);
        // Routed by conversations.channel — an automation triggered by
        // an Instagram DM replies on Instagram, with no branch here.
        const { messageId } = await this.channelSender.sendText({
          accountId: args.automation.accountId,
          conversationId,
          contactId: args.contactId,
          text,
        });
        return `sent on ${args.context?.channel ?? 'whatsapp'} (${messageId})`;
      }

      case 'send_template': {
        const cfg = step.stepConfig as SendTemplateStepConfig;
        if (!args.contactId) throw new Error('send_template needs a contact');
        if (!cfg.template_name)
          throw new Error('send_template needs template_name');
        const conversationId = await this.resolveConversationId(args);
        // WhatsApp-only. Instagram has no approved-template mechanism,
        // so this raises UnsupportedOnChannelError rather than sending
        // the raw template name as text — which is what a naive
        // fallback would do, and would look like a bug to the customer.
        await this.channelSender.assertSupported(
          args.automation.accountId,
          conversationId,
          'templates',
        );
        // Meta templates use positional {{1}}, {{2}}, … placeholders, so
        // we MUST emit params in strict numeric order. Lexicographic sort
        // of "1", "2", …, "10" yields "1", "10", "2", … which silently
        // scrambles every template with ≥10 variables.
        const params = cfg.variables
          ? Object.keys(cfg.variables)
              .sort((a, b) => {
                const na = Number(a);
                const nb = Number(b);
                const aNum = Number.isFinite(na);
                const bNum = Number.isFinite(nb);
                if (aNum && bNum) return na - nb;
                if (aNum) return -1;
                if (bNum) return 1;
                return a.localeCompare(b);
              })
              .map((k) => String(cfg.variables![k]))
          : [];
        const { whatsapp_message_id } = await this.metaSend.sendTemplate({
          accountId: args.automation.accountId,
          conversationId,
          contactId: args.contactId,
          templateName: cfg.template_name,
          language: cfg.language,
          params,
        });
        return `template sent via Meta (${whatsapp_message_id})`;
      }

      case 'add_tag': {
        // contact_tags has no account_id column; cross-tenant protection
        // for the attacker-supplied contactId comes from the ownership
        // guard in AutomationDispatchService.
        const cfg = step.stepConfig as TagStepConfig;
        if (!args.contactId || !cfg.tag_id)
          throw new Error('add_tag needs contact + tag_id');
        await this.prisma.contact_tags.upsert({
          where: {
            contact_id_tag_id: {
              contact_id: args.contactId,
              tag_id: cfg.tag_id,
            },
          },
          create: { contact_id: args.contactId, tag_id: cfg.tag_id },
          update: {},
        });
        return `tag ${cfg.tag_id} added`;
      }

      case 'remove_tag': {
        // See add_tag: tenant scoping relies on the dispatch service's
        // ownership guard, since contact_tags carries no account_id.
        const cfg = step.stepConfig as TagStepConfig;
        if (!args.contactId || !cfg.tag_id)
          throw new Error('remove_tag needs contact + tag_id');
        await this.prisma.contact_tags.deleteMany({
          where: { contact_id: args.contactId, tag_id: cfg.tag_id },
        });
        return `tag ${cfg.tag_id} removed`;
      }

      case 'assign_conversation': {
        const cfg = step.stepConfig as AssignConversationStepConfig;
        if (!args.contactId)
          throw new Error('assign_conversation needs a contact');
        let agentId = cfg.agent_id;
        if (cfg.mode === 'round_robin') {
          // Pick any member of the account. The existing implementation
          // only ever returned the automation's author; preserving that
          // shape until a real round-robin algorithm replaces it.
          const profile = await this.prisma.profile.findFirst({
            where: { accountId: args.automation.accountId },
            select: { userId: true },
          });
          agentId = profile?.userId;
        }
        if (!agentId) return 'no agent resolved';
        await this.prisma.conversations.updateMany({
          // Channel-scoped — assigning an Instagram thread must not
          // also reassign the contact's WhatsApp one.
          where: this.conversationScope(args),
          data: { assigned_agent_id: agentId },
        });
        return `assigned to ${agentId}`;
      }

      case 'update_contact_field': {
        const cfg = step.stepConfig as UpdateContactFieldStepConfig;
        if (!args.contactId)
          throw new Error('update_contact_field needs a contact');
        // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so
        // custom values can be populated dynamically from the triggering
        // context.
        const value = interpolate(cfg.value, args.context);

        // Custom fields are encoded as `custom:<custom_field_id>`; anything
        // else is a built-in contact column.
        if (cfg.field.startsWith('custom:')) {
          const customFieldId = cfg.field.slice('custom:'.length);
          if (!customFieldId) {
            return `field ${cfg.field} not writable from automations`;
          }
          // Defense in depth: the bypassrls Prisma connection skips RLS,
          // so confirm the field definition belongs to this account
          // before writing.
          const field = await this.prisma.custom_fields.findFirst({
            where: { id: customFieldId, account_id: args.automation.accountId },
            select: { id: true },
          });
          if (!field) {
            return `field ${cfg.field} not writable from automations`;
          }
          // Upsert on the table's UNIQUE(contact_id, custom_field_id) so
          // repeated runs overwrite rather than duplicate.
          await this.prisma.contact_custom_values.upsert({
            where: {
              contact_id_custom_field_id: {
                contact_id: args.contactId,
                custom_field_id: customFieldId,
              },
            },
            create: {
              contact_id: args.contactId,
              custom_field_id: customFieldId,
              value,
            },
            update: { value },
          });
          return `custom field updated`;
        }

        const allowed = new Set(['name', 'email', 'company']);
        if (!allowed.has(cfg.field)) {
          return `field ${cfg.field} not writable from automations`;
        }
        // Defense in depth: scope the write to the account so a future
        // caller that skips the entry-point ownership guard still cannot
        // write across tenants.
        await this.prisma.contacts.updateMany({
          where: { id: args.contactId, account_id: args.automation.accountId },
          data: {
            [cfg.field]: value,
            updated_at: new Date(),
          } as Prisma.contactsUpdateManyMutationInput,
        });
        return `${cfg.field} updated`;
      }

      case 'create_deal': {
        const cfg = step.stepConfig as CreateDealStepConfig;
        if (!cfg.pipeline_id || !cfg.stage_id)
          throw new Error('create_deal needs pipeline + stage');
        // Match the account's configured default currency rather than a
        // static DB default — keeps automation-created deals consistent
        // with the one-currency-per-account rule. Falls back to USD.
        const acct = await this.prisma.account.findUnique({
          where: { id: args.automation.accountId },
          select: { defaultCurrency: true },
        });
        await this.prisma.deals.create({
          data: {
            account_id: args.automation.accountId,
            user_id: args.automation.userId,
            pipeline_id: cfg.pipeline_id,
            stage_id: cfg.stage_id,
            contact_id: args.contactId,
            title: interpolate(cfg.title, args.context),
            value: cfg.value ?? 0,
            currency: acct?.defaultCurrency ?? 'USD',
            status: 'open',
          },
        });
        return 'deal created';
      }

      case 'send_webhook': {
        const cfg = step.stepConfig as SendWebhookStepConfig;
        if (!cfg.url) throw new Error('send_webhook needs url');
        // SSRF guard: the URL and headers are account-controlled and the
        // server makes the request, so refuse any destination that
        // resolves to a private / loopback / link-local / reserved
        // address.
        if (!(await isDeliverableUrl(cfg.url))) {
          throw new Error('send_webhook: destination not allowed');
        }
        const body = cfg.body_template
          ? interpolate(cfg.body_template, args.context)
          : JSON.stringify(args.context);
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.headers ?? {}),
          },
          body,
          // Do NOT follow redirects — a public URL could 3xx-bounce to an
          // internal address, defeating the guard above. Bound the
          // request so a hung/slow internal host can't tie up the runner.
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`webhook returned ${res.status}`);
        return `webhook ${res.status}`;
      }

      case 'close_conversation': {
        if (!args.contactId)
          throw new Error('close_conversation needs a contact');
        await this.prisma.conversations.updateMany({
          // Channel-scoped — see conversationScope. Closing one
          // platform's thread should not close the other's.
          where: this.conversationScope(args),
          data: { status: 'closed', updated_at: new Date() },
        });
        return 'conversation closed';
      }

      default:
        return `unknown step: ${step.stepType}`;
    }
  }

  /**
   * Pick the conversation a send-type step should use. Prefer the id the
   * webhook handed us (it's the one that just got the inbound message);
   * fall back to the contact's conversation for resumed/wait paths and
   * manual engine calls. Throws if none exists — send steps have no
   * meaningful target without a conversation.
   */
  /**
   * Narrow a bulk conversation update to the triggering channel.
   *
   * `assign_conversation` and `close_conversation` both operate on
   * "this contact's conversations". Left unscoped they act on every
   * thread the contact owns — so closing an Instagram thread would
   * also close their WhatsApp one. When the event names a channel,
   * confine the write to it.
   */
  private conversationScope(args: StepExecutionArgs) {
    const channel = args.context?.channel;
    return {
      account_id: args.automation.accountId,
      contact_id: args.contactId!,
      ...(channel ? { channel } : {}),
    };
  }

  private async resolveConversationId(
    args: StepExecutionArgs,
  ): Promise<string> {
    const fromCtx = args.context.conversation_id;
    if (fromCtx) return fromCtx;
    if (!args.contactId)
      throw new Error('cannot resolve conversation: no contact');
    // Pin the channel when the triggering event told us one.
    //
    // An earlier version left this unfiltered, reasoning that a contact
    // owns at most one thread because identities are not merged across
    // channels. That holds for contacts created BY a channel, but not
    // for the Instagram comment funnel: a commenter who is already a
    // WhatsApp contact has a WhatsApp thread, and an unfiltered lookup
    // would send the comment's reply there — to the wrong person's
    // phone, on the wrong platform.
    //
    // Falls back to unfiltered when the context carries no channel
    // (time-based runs, the manual entrypoint), which preserves the
    // original behaviour for every path that has no better answer.
    const channel = args.context?.channel;

    const convo = await this.prisma.conversations.findFirst({
      where: {
        account_id: args.automation.accountId,
        contact_id: args.contactId,
        ...(channel ? { channel } : {}),
      },
      // If two threads ever do exist, prefer the more recently active
      // one over an arbitrary row.
      orderBy: { last_message_at: 'desc' },
    });
    if (!convo) {
      throw new Error(
        channel
          ? `no ${channel} conversation for contact`
          : 'no conversation for contact',
      );
    }
    return convo.id;
  }

  private waitMs(cfg: WaitStepConfig): number {
    const unitMs =
      cfg.unit === 'days'
        ? 86_400_000
        : cfg.unit === 'hours'
          ? 3_600_000
          : 60_000;
    return Math.max(1_000, cfg.amount * unitMs);
  }

  async appendResults(
    logId: string | null,
    newItems: AutomationLogStepResult[],
    status: 'success' | 'partial' | 'failed' | null,
    errorMessage: string | null,
  ): Promise<void> {
    if (!logId) return;
    const existing = await this.prisma.automationLog.findUnique({
      where: { id: logId },
      select: { stepsExecuted: true },
    });
    const existingItems = Array.isArray(existing?.stepsExecuted)
      ? existing.stepsExecuted
      : [];
    const merged = [
      ...existingItems,
      ...newItems,
    ] as unknown as Prisma.InputJsonValue;
    const data: Prisma.AutomationLogUpdateInput = { stepsExecuted: merged };
    // Only overwrite status on the outermost scope — nested branches pass null.
    if (status !== null) data.status = status;
    if (errorMessage) data.errorMessage = errorMessage;
    await this.prisma.automationLog.update({ where: { id: logId }, data });
  }

  async finalizeLog(
    logId: string | null,
    status: 'success' | 'partial' | 'failed',
    errorMessage: string | null,
  ): Promise<void> {
    if (!logId) return;
    await this.prisma.automationLog.update({
      where: { id: logId },
      data: { status, errorMessage },
    });
  }
}
