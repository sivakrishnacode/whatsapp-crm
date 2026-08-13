import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationMetaSendService } from '../../whatsapp/automation-meta-send.service';
import {
  ChannelSenderService,
  NoReachableConversationError,
  UnsupportedOnChannelError,
} from '../../common/messaging/channel-sender.service';
import { SegmentMembershipService } from '../../common/segments/segment-membership.service';
import { FlowDispatchService } from '../../flows/services/flow-dispatch.service';
import { AutomationConditionService } from './automation-condition.service';
import { interpolate, resolveValue } from './automation-interpolation.util';
import {
  HttpStepError,
  performHttpStep,
  redactUrl,
  type HttpStepOutput,
} from './automation-http.util';
import type {
  AddNoteStepConfig,
  AssignConversationStepConfig,
  AutomationContext,
  AutomationLogStepResult,
  AutomationStepType,
  CommonStepOptions,
  ConditionStepConfig,
  CreateDealStepConfig,
  NotifyTeamStepConfig,
  RandomSplitStepConfig,
  RunAutomationStepConfig,
  SegmentStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendMediaStepConfig,
  SendMessageStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  SetConversationStatusStepConfig,
  SetVariableStepConfig,
  StartFlowStepConfig,
  StepExecutionArgs,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  UpdateDealStepConfig,
  WaitStepConfig,
  WaitUntilStepConfig,
} from '../automation.types';

export const AUTOMATIONS_PENDING_QUEUE = 'automations-pending';

/**
 * How many `run_automation` hops one run may make.
 *
 * Two automations that call each other is not an obviously wrong thing to
 * write, and without a ceiling it fills the queue until Redis falls over.
 * Three is deep enough for "qualify → enrich → notify" and shallow enough
 * that a cycle dies immediately.
 */
export const MAX_AUTOMATION_DEPTH = 3;

/**
 * What a step publishes to later steps, plus the human-readable line for
 * the log. `output` lands in `context.steps[<key>]`; `detail` is what the
 * logs UI renders.
 */
interface StepResult {
  detail: string;
  output?: unknown;
}

/**
 * Cap on the output copied into a log row.
 *
 * The log is read on every open of the logs page AND by the editor, for
 * every run. An HTTP step can return megabytes; storing all of it would
 * bloat every row for a benefit that stops after the first few fields —
 * the editor only needs enough to show the SHAPE of what came back.
 */
export const LOG_OUTPUT_MAX_BYTES = 4_000;

/**
 * The output as it goes into the log: whole when small, and replaced by
 * a marker when not.
 *
 * Deliberately NOT a partial object. Half a JSON body looks like a
 * complete one with fields missing, and somebody would build a token
 * path against a field that was merely cut off.
 */
function truncateOutput(output: unknown): unknown {
  if (output === undefined || output === null) return undefined;
  try {
    const json = JSON.stringify(output);
    if (json === undefined) return undefined;
    if (json.length <= LOG_OUTPUT_MAX_BYTES) return output;
    return {
      _truncated: true,
      _bytes: json.length,
      _note: 'Too large to keep in the log. The full value was available to later steps at run time.',
    };
  } catch {
    // Circular or otherwise unserialisable — the run does not care, but
    // the log write would throw.
    return undefined;
  }
}

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
    private readonly segments: SegmentMembershipService,
    /** `start_flow`. forwardRef because FlowsModule and AutomationsModule
     *  both sit at the same layer and each can now reach the other. */
    @Inject(forwardRef(() => FlowDispatchService))
    private readonly flows: FlowDispatchService,
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
      const options = (step.stepConfig ?? {}) as CommonStepOptions;

      // A disabled step is not a failure and not an omission — it is a
      // step the author switched off. Logging it as skipped is how they
      // find out why the run did nothing, rather than concluding the
      // engine dropped it.
      if (options.disabled) {
        results.push({
          step_id: step.id,
          step_key: step.key ?? null,
          step_type: step.stepType as AutomationStepType,
          status: 'skipped',
          detail: 'step is switched off',
        });
        continue;
      }

      // `wait` and `wait_until` are the suspension points: enqueue and
      // stop processing this scope. The BullMQ processor picks it up
      // later, with the context — including every step output collected
      // so far — restored from the pending row.
      if (step.stepType === 'wait' || step.stepType === 'wait_until') {
        const ms =
          step.stepType === 'wait'
            ? this.waitMs(step.stepConfig as unknown as WaitStepConfig)
            : this.waitUntilMs(
                step.stepConfig as unknown as WaitUntilStepConfig,
              );
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
          step_key: step.key ?? null,
          step_type: step.stepType as AutomationStepType,
          status: 'success',
          detail: `resuming in ${Math.round(ms / 1000)}s`,
        });
        status = 'partial';
        await this.appendResults(args.logId, results, status, errorMessage);
        return;
      }

      try {
        if (step.stepType === 'condition' || step.stepType === 'random_split') {
          const taken =
            step.stepType === 'condition'
              ? await this.condition.evaluate(
                  step.stepConfig as unknown as ConditionStepConfig,
                  args,
                )
              : this.rollSplit(
                  step.stepConfig as unknown as RandomSplitStepConfig,
                );
          results.push({
            step_id: step.id,
            step_key: step.key ?? null,
            step_type: step.stepType as AutomationStepType,
            status: 'success',
            detail: `branch=${taken ? 'yes' : 'no'}`,
          });
          // The branch a run took is itself data — a later step can send
          // a different message to the half that got the discount.
          this.publishOutput(step, args, { branch: taken ? 'yes' : 'no' });
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

        const { detail, output } = await this.runStep(step, args);
        // Publish BEFORE the next step runs — that ordering is the whole
        // feature: step N+1 builds its request out of step N's output.
        this.publishOutput(step, args, output);
        results.push({
          step_id: step.id,
          step_key: step.key ?? null,
          step_type: step.stepType as AutomationStepType,
          status: 'success',
          detail,
          // Recorded so the EDITOR can show what this step really
          // returned last time, next to each token that reads it.
          // Guessing at sample values would be worse than none: somebody
          // would build a body around a field shape that does not exist.
          output: truncateOutput(output),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // An HTTP step that failed still has a status code and a body,
        // and a `continue`-on-error step exists precisely so the run can
        // branch on them. Publish before deciding what to do with the
        // error, or "if the lookup 404s, do X" is unwritable.
        if (err instanceof HttpStepError && err.output) {
          this.publishOutput(step, args, err.output);
        }

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
        // Two different questions — "this channel cannot do that" and
        // "there is nobody to send it to" — with the same right answer:
        // skip the step, mark the run partial, keep going. A
        // form_submitted automation on a hosted submission has no
        // conversation, and its tag / deal / webhook steps must still run.
        if (
          err instanceof UnsupportedOnChannelError ||
          err instanceof NoReachableConversationError
        ) {
          results.push({
            step_id: step.id,
            step_key: step.key ?? null,
            step_type: step.stepType as AutomationStepType,
            status: 'skipped',
            detail: msg,
          });
          if (status === 'success') status = 'partial';
          continue;
        }

        results.push({
          step_id: step.id,
          step_key: step.key ?? null,
          step_type: step.stepType as AutomationStepType,
          status: 'failed',
          detail: msg,
        });

        // `on_error: continue` — the step failed, the RUN carries on.
        //
        // The default (abort) is right for a send that depends on a
        // lookup: firing it with half the data is worse than not firing
        // it. It is wrong for the "also ping our CRM" step at the end,
        // where a third party being down should not cancel the tag and
        // the deal that already succeeded. The run still ends `failed`,
        // so nobody has to read the whole log to notice something broke.
        if (options.on_error === 'continue') {
          if (!errorMessage) errorMessage = msg;
          status = 'failed';
          continue;
        }

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

  /**
   * Steps that PRODUCE something a later step can read.
   *
   * Split from the original switch (now `runLegacyStep`) along that
   * line rather than by age: these return a structured `output` that
   * lands in `context.steps[<key>]`, the others return a log line and
   * nothing else. Keeping the two apart stops every existing case from
   * having to be rewritten to say `{ detail }`.
   */
  private async runStep(
    step: {
      id: string;
      key?: string | null;
      stepType: string;
      stepConfig: unknown;
      position: number;
    },
    args: StepExecutionArgs,
  ): Promise<StepResult> {
    switch (step.stepType) {
      case 'http_request':
      case 'send_webhook': {
        const cfg = step.stepConfig as SendWebhookStepConfig;
        if (!cfg.url) throw new Error(`${step.stepType} needs a url`);
        const output = await performHttpStep(cfg, args.context);
        return {
          // The URL is redacted: automation logs are readable by every
          // member of the workspace and an API key in a query string is
          // exactly what ends up there.
          detail: `${cfg.method ?? 'POST'} ${redactUrl(
            interpolate(cfg.url, args.context),
          )} → ${output.status} in ${output.duration_ms}ms`,
          output,
        };
      }

      case 'set_variable': {
        const cfg = step.stepConfig as SetVariableStepConfig;
        const name = String(cfg.name ?? '').trim();
        if (!name) throw new Error('set_variable needs a name');
        // resolveValue, not interpolate: a config that is exactly one
        // token keeps the underlying type, so `{{ steps.x.body }}` stores
        // the object rather than a string of JSON that nothing can index.
        const value = resolveValue(cfg.value, args.context);
        args.context.vars = { ...(args.context.vars ?? {}), [name]: value };
        return {
          detail: `${name} set`,
          output: { name, value },
        };
      }

      case 'send_media': {
        const cfg = step.stepConfig as SendMediaStepConfig;
        if (!args.contactId) throw new Error('send_media needs a contact');
        const link = interpolate(String(cfg.link ?? ''), args.context);
        if (!link.trim()) throw new Error('send_media needs a link');
        const conversationId = await this.resolveConversationId(args);
        const { messageId } = await this.channelSender.sendMedia({
          accountId: args.automation.accountId,
          conversationId,
          contactId: args.contactId,
          kind: cfg.kind ?? 'image',
          link,
          caption: cfg.caption
            ? interpolate(cfg.caption, args.context)
            : undefined,
          filename: cfg.filename
            ? interpolate(cfg.filename, args.context)
            : undefined,
        });
        return { detail: `${cfg.kind ?? 'image'} sent (${messageId})`, output: { message_id: messageId } };
      }

      case 'send_buttons': {
        const cfg = step.stepConfig as SendButtonsStepConfig;
        if (!args.contactId) throw new Error('send_buttons needs a contact');
        const buttons = (cfg.buttons ?? [])
          .map((b, i) => ({
            // A stable id matters beyond this send: it is what comes back
            // on the webhook when the recipient taps, and what a flow or
            // a keyword automation matches on.
            id: (b.id?.trim() || `btn_${i + 1}`).slice(0, 256),
            title: interpolate(String(b.title ?? ''), args.context),
          }))
          .filter((b) => b.title.trim());
        if (buttons.length === 0) {
          throw new Error('send_buttons needs at least one button');
        }
        const conversationId = await this.resolveConversationId(args);
        const { messageId } = await this.channelSender.sendButtons({
          accountId: args.automation.accountId,
          conversationId,
          contactId: args.contactId,
          bodyText: interpolate(String(cfg.body_text ?? ''), args.context),
          buttons,
          headerText: cfg.header_text
            ? interpolate(cfg.header_text, args.context)
            : undefined,
          footerText: cfg.footer_text
            ? interpolate(cfg.footer_text, args.context)
            : undefined,
        });
        return {
          detail: `${buttons.length} button(s) sent (${messageId})`,
          output: { message_id: messageId, button_ids: buttons.map((b) => b.id) },
        };
      }

      case 'send_list': {
        const cfg = step.stepConfig as SendListStepConfig;
        if (!args.contactId) throw new Error('send_list needs a contact');
        const sections = (cfg.sections ?? []).map((s, si) => ({
          title: interpolate(String(s.title ?? `Section ${si + 1}`), args.context),
          rows: (s.rows ?? [])
            .map((r, ri) => ({
              id: (r.id?.trim() || `row_${si + 1}_${ri + 1}`).slice(0, 200),
              title: interpolate(String(r.title ?? ''), args.context),
              description: r.description
                ? interpolate(r.description, args.context)
                : undefined,
            }))
            .filter((r) => r.title.trim()),
        }));
        if (!sections.some((s) => s.rows.length > 0)) {
          throw new Error('send_list needs at least one row');
        }
        const conversationId = await this.resolveConversationId(args);
        // Instagram has no list message; assertSupported/sendList raises
        // UnsupportedOnChannelError, which the loop above treats as a
        // skip rather than a failure.
        const { messageId } = await this.channelSender.sendList({
          accountId: args.automation.accountId,
          conversationId,
          contactId: args.contactId,
          bodyText: interpolate(String(cfg.body_text ?? ''), args.context),
          buttonLabel: interpolate(
            String(cfg.button_label ?? 'Choose'),
            args.context,
          ),
          sections,
          headerText: cfg.header_text
            ? interpolate(cfg.header_text, args.context)
            : undefined,
          footerText: cfg.footer_text
            ? interpolate(cfg.footer_text, args.context)
            : undefined,
        });
        return { detail: `list sent (${messageId})`, output: { message_id: messageId } };
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
        // Both ids come from a config blob and Prisma bypasses RLS, so
        // pin the stage to a pipeline this account owns. Without it a
        // copied automation could file deals into another tenant's board.
        const stage = await this.prisma.pipeline_stages.findFirst({
          where: {
            id: cfg.stage_id,
            pipeline_id: cfg.pipeline_id,
            pipelines: { account_id: args.automation.accountId },
          },
          select: { id: true },
        });
        if (!stage) {
          throw new Error('that pipeline stage is not in this workspace');
        }
        const deal = await this.prisma.deals.create({
          data: {
            account_id: args.automation.accountId,
            user_id: args.automation.userId,
            pipeline_id: cfg.pipeline_id,
            stage_id: cfg.stage_id,
            contact_id: args.contactId,
            title: interpolate(cfg.title, args.context),
            value: this.toDecimal(cfg.value, args.context) ?? 0,
            currency: acct?.defaultCurrency ?? 'USD',
            status: 'open',
          },
          select: { id: true, title: true },
        });
        return {
          detail: 'deal created',
          // The id is the point: "create a deal, then post its id to
          // Slack" is not expressible without it.
          output: { deal_id: deal.id, title: deal.title },
        };
      }

      case 'update_deal': {
        const cfg = step.stepConfig as UpdateDealStepConfig;
        const dealId =
          cfg.target === 'by_id'
            ? interpolate(String(cfg.deal_id ?? ''), args.context).trim()
            : await this.latestDealIdForContact(args);
        if (!dealId) {
          throw new Error(
            cfg.target === 'by_id'
              ? 'update_deal needs a deal id'
              : 'this contact has no deal to update',
          );
        }
        if (cfg.stage_id) {
          // Same cross-tenant reasoning as create_deal: a stage id from
          // config is not authority.
          const stage = await this.prisma.pipeline_stages.findFirst({
            where: {
              id: cfg.stage_id,
              pipelines: { account_id: args.automation.accountId },
            },
            select: { id: true },
          });
          if (!stage) {
            throw new Error('that pipeline stage is not in this workspace');
          }
        }
        const value = this.toDecimal(cfg.value, args.context);
        const updated = await this.prisma.deals.updateMany({
          // Account-scoped so a deal id from a config blob cannot reach
          // another tenant's board.
          where: { id: dealId, account_id: args.automation.accountId },
          data: {
            ...(cfg.stage_id ? { stage_id: cfg.stage_id } : {}),
            ...(cfg.status ? { status: cfg.status } : {}),
            ...(value !== undefined ? { value } : {}),
            ...(cfg.title
              ? { title: interpolate(cfg.title, args.context) }
              : {}),
            updated_at: new Date(),
          },
        });
        if (updated.count === 0) {
          throw new Error('deal not found in this workspace');
        }
        return { detail: `deal ${dealId} updated`, output: { deal_id: dealId } };
      }

      case 'add_note': {
        const cfg = step.stepConfig as AddNoteStepConfig;
        if (!args.contactId) throw new Error('add_note needs a contact');
        const text = interpolate(String(cfg.text ?? ''), args.context);
        if (!text.trim()) throw new Error('add_note has empty text');
        const note = await this.prisma.contact_notes.create({
          data: {
            account_id: args.automation.accountId,
            contact_id: args.contactId,
            // The automation's author owns notes it writes: contact_notes
            // requires a user, and attributing them to the person who
            // wrote the rule is the only honest answer available.
            user_id: args.automation.userId,
            note_text: text,
          },
          select: { id: true },
        });
        return { detail: 'note added', output: { note_id: note.id } };
      }

      case 'notify_team': {
        const cfg = step.stepConfig as NotifyTeamStepConfig;
        const title = interpolate(String(cfg.title ?? ''), args.context);
        if (!title.trim()) throw new Error('notify_team needs a title');
        const body = cfg.body ? interpolate(cfg.body, args.context) : null;
        const userIds = await this.notifyRecipients(cfg, args);
        if (userIds.length === 0) return { detail: 'nobody to notify' };
        await this.prisma.notifications.createMany({
          data: userIds.map((userId) => ({
            account_id: args.automation.accountId,
            user_id: userId,
            type: 'automation',
            contact_id: args.contactId,
            conversation_id: args.context.conversation_id ?? null,
            title,
            body,
          })),
        });
        return {
          detail: `notified ${userIds.length} member(s)`,
          output: { notified: userIds.length },
        };
      }

      case 'set_conversation_status': {
        const cfg = step.stepConfig as SetConversationStatusStepConfig;
        if (!args.contactId)
          throw new Error('set_conversation_status needs a contact');
        const status = cfg.status ?? 'open';
        await this.prisma.conversations.updateMany({
          where: this.conversationScope(args),
          data: { status, updated_at: new Date() },
        });
        return { detail: `conversation set to ${status}` };
      }

      case 'start_flow': {
        const cfg = step.stepConfig as StartFlowStepConfig;
        if (!cfg.flow_id) throw new Error('start_flow needs a flow');
        if (!args.contactId) throw new Error('start_flow needs a contact');
        // A flow talks to somebody, so it needs a thread to talk on.
        // resolveConversationId throws NoReachableConversationError,
        // which the loop treats as a skip — right answer for a
        // form_submitted run whose contact has never messaged.
        const conversationId = await this.resolveConversationId(args);
        const result = await this.flows.startForContact({
          accountId: args.automation.accountId,
          flowId: cfg.flow_id,
          contactId: args.contactId,
          conversationId,
          userId: args.automation.userId,
        });
        if (!result.consumed) {
          // Not an exception: the usual causes are a draft flow or a
          // contact already in one, and neither should fail a run that
          // has already tagged and assigned correctly.
          return {
            detail: `flow not started (${result.outcome ?? 'no match'})`,
            output: { started: false, outcome: result.outcome ?? null },
          };
        }
        return {
          detail: `flow started (${result.flow_run_id ?? 'run'})`,
          output: { started: true, flow_run_id: result.flow_run_id ?? null },
        };
      }

      case 'run_automation': {
        const cfg = step.stepConfig as RunAutomationStepConfig;
        if (!cfg.automation_id) throw new Error('run_automation needs a target');
        if (cfg.automation_id === args.automation.id) {
          // Direct self-recursion is never what someone meant, and the
          // depth counter would only catch it three runs later.
          throw new Error('an automation cannot run itself');
        }
        const depth = args.context.depth ?? 0;
        if (depth >= MAX_AUTOMATION_DEPTH) {
          throw new Error(
            `automation chain is too deep (limit ${MAX_AUTOMATION_DEPTH}) — check for a loop`,
          );
        }
        const target = await this.prisma.automation.findFirst({
          // Account-scoped: the id comes from a config blob.
          where: {
            id: cfg.automation_id,
            accountId: args.automation.accountId,
          },
          select: { id: true, name: true, isActive: true, userId: true },
        });
        if (!target) throw new Error('that automation is not in this workspace');
        if (!target.isActive) {
          return { detail: `"${target.name}" is inactive — not run` };
        }
        // Run inline rather than through dispatch: dispatch re-matches
        // triggers, and this target's trigger has nothing to do with why
        // it is being called. The context (vars, step outputs) carries
        // over, which is the reason to call a sub-automation at all.
        await this.executeStepsFrom({
          automation: {
            id: target.id,
            accountId: args.automation.accountId,
            userId: target.userId,
          },
          contactId: args.contactId,
          context: { ...args.context, depth: depth + 1 },
          parentStepId: null,
          branch: null,
          startPosition: 0,
          // Its own log row would be orphaned from any trigger; keeping
          // the caller's log means one readable timeline.
          logId: args.logId,
          triggerEvent: `run_automation:${args.triggerEvent}`,
        });
        return {
          detail: `ran "${target.name}"`,
          output: { automation_id: target.id },
        };
      }

      default:
        return { detail: await this.runLegacyStep(step, args) };
    }
  }

  /**
   * Steps whose only product is a log line.
   *
   * This is the original switch, unchanged apart from `create_deal` and
   * `send_webhook` moving up into `runStep` (they now publish an output).
   */
  private async runLegacyStep(
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
        // Values are interpolated the same way `send_message` text is,
        // so a template variable can carry `{{contact.name}}` or
        // `{{message.text}}` rather than only a fixed string. Without
        // this, "Hi {{1}}" could only ever greet everyone identically —
        // which is most of the reason to use a template with a variable
        // at all.
        const templateContext = await this.withContactTokens(
          args.context,
          args.contactId,
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
              .map((k) =>
                interpolate(String(cfg.variables![k]), templateContext),
              )
          : [];

        // Header and button values travel alongside the body ones.
        // Meta rejects the whole send if a template's LOCATION pin,
        // media URL or button substitution is missing, so a config that
        // carries them has to be able to deliver them.
        const fill = (v: string | undefined) =>
          v ? interpolate(v, templateContext) : undefined;

        const buttonParams = cfg.button_params
          ? Object.fromEntries(
              Object.entries(cfg.button_params).map(
                ([index, value]): [number, string] => [
                  Number(index),
                  interpolate(String(value), templateContext),
                ],
              ),
            )
          : undefined;

        const { whatsapp_message_id } = await this.metaSend.sendTemplate({
          accountId: args.automation.accountId,
          conversationId,
          contactId: args.contactId,
          templateName: cfg.template_name,
          language: cfg.language,
          params,
          headerText: fill(cfg.header_text),
          headerMediaUrl: fill(cfg.header_media_url),
          headerLocation: cfg.header_location
            ? {
                latitude: interpolate(
                  cfg.header_location.latitude,
                  templateContext,
                ),
                longitude: interpolate(
                  cfg.header_location.longitude,
                  templateContext,
                ),
                name: fill(cfg.header_location.name),
                address: fill(cfg.header_location.address),
              }
            : undefined,
          buttonParams,
        });
        return `template sent via Meta (${whatsapp_message_id})`;
      }

      /**
       * Send someone a form or a booking page.
       *
       * ONE IMPLEMENTATION FOR BOTH, AND FOR EVERY CHANNEL
       *   Both send a message containing a public URL, which every channel
       *   can carry — so this rides `ChannelSenderService.sendText` and
       *   works on WhatsApp, Instagram and web without a branch.
       *
       *   The web channel could do better (an inline card the widget
       *   renders, so a visitor already in a browser does not open a new
       *   tab). That lives in `WebSendService.sendCard` and is wired up in
       *   the widget; routing to it from here would need the sender to
       *   expose a card method on every channel, which it deliberately
       *   does not. A link on web is correct, just not optimal.
       */
      case 'send_form':
      case 'send_booking_link': {
        const cfg = step.stepConfig as {
          form_id?: string;
          appointment_type_id?: string;
          message_text?: string;
        };
        if (!args.contactId)
          throw new Error(`${step.stepType} needs a contact`);

        const targetId =
          step.stepType === 'send_form' ? cfg.form_id : cfg.appointment_type_id;
        if (!targetId) {
          throw new Error(
            `${step.stepType} needs a ${step.stepType === 'send_form' ? 'form' : 'appointment type'}`,
          );
        }

        const link = await this.resolvePublicLink(
          args.automation.accountId,
          step.stepType,
          targetId,
        );
        if (!link) {
          // Unpublished or deleted. A message containing a dead link is
          // worse than no message: the recipient tries it, it 404s, and
          // they conclude the business is broken.
          throw new Error(
            step.stepType === 'send_form'
              ? 'that form is not published, so no link was sent'
              : 'that appointment type is not bookable, so no link was sent',
          );
        }

        const intro = cfg.message_text
          ? interpolate(cfg.message_text, args.context)
          : step.stepType === 'send_form'
            ? 'Please fill in this short form:'
            : 'Pick a time that suits you:';

        const conversationId = await this.resolveConversationId(args);
        const { messageId } = await this.channelSender.sendText({
          accountId: args.automation.accountId,
          conversationId,
          contactId: args.contactId,
          text: `${intro}\n${link}`,
        });
        return `${step.stepType} sent (${messageId})`;
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

      case 'add_to_segment':
      case 'remove_from_segment': {
        // Unlike add_tag, this does NOT lean on the dispatch guard
        // alone. The segment id comes from a config blob and the
        // contact id ultimately from a webhook payload, so both ends
        // are pinned: findForAccount pins the segment to this
        // automation's workspace, and add_contacts_to_segment pins the
        // contact to the segment's. Either check alone leaves a
        // cross-tenant write open.
        const cfg = step.stepConfig as SegmentStepConfig;
        if (!args.contactId || !cfg.segment_id)
          throw new Error(`${step.stepType} needs contact + segment_id`);

        const segment = await this.segments.findForAccount(
          args.automation.accountId,
          cfg.segment_id,
        );
        if (!segment) throw new Error('segment not found in this workspace');
        if (segment.kind !== 'static') {
          // Not silently ignored: somebody pointed an automation at a
          // saved filter and is expecting it to be doing something.
          throw new Error(
            `"${segment.name}" is a dynamic segment — its membership comes from its filter and cannot be edited`,
          );
        }

        if (step.stepType === 'add_to_segment') {
          const added = await this.segments.add(
            segment.id,
            [args.contactId],
            'automation',
          );
          return added > 0
            ? `added to segment "${segment.name}"`
            : `already in segment "${segment.name}"`;
        }

        const removed = await this.segments.remove(segment.id, [
          args.contactId,
        ]);
        return removed > 0
          ? `removed from segment "${segment.name}"`
          : `was not in segment "${segment.name}"`;
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

  /**
   * The public URL for a form or an appointment type, or null when it is
   * not publicly reachable.
   *
   * Account-scoped, and reads the raw tables rather than injecting
   * FormsService / AppointmentTypesService. That is a deliberate trade:
   * importing them would put AutomationsModule → FormsModule →
   * AutomationsModule in the graph, and both of those modules already
   * depend on this one for dispatch. Two `findFirst`s avoid a third
   * forwardRef cycle for what is a slug lookup.
   */
  private async resolvePublicLink(
    accountId: string,
    stepType: 'send_form' | 'send_booking_link',
    targetId: string,
  ): Promise<string | null> {
    const base =
      process.env.PUBLIC_APP_URL?.replace(/\/+$/, '') ??
      'http://localhost:3000';

    if (stepType === 'send_form') {
      const form = await this.prisma.forms.findFirst({
        where: { id: targetId, account_id: accountId, status: 'published' },
        select: { slug: true },
      });
      return form ? `${base}/f/${form.slug}` : null;
    }

    // appointment_types lives in migration 055 (Phase 6).
    // Until that schema is applied, the model does not exist on PrismaClient.
    // The `as any` cast is intentional and will be removed once the Prisma
    // client is regenerated after running 055.

    const type = await (this.prisma as any).appointment_types?.findFirst({
      where: { id: targetId, account_id: accountId, is_active: true },
      select: { slug: true },
    });
    return type ? `${base}/book/${type.slug}` : null;
  }

  /**
   * The step's context with a `contact` namespace attached, so
   * `{{contact.name}}` resolves inside a template variable.
   *
   * Loaded here rather than at dispatch because only template variables
   * read it today — making every run of every automation pay for a
   * contact lookup would be a cost with almost no reader. Returns the
   * context untouched when there is no contact or the lookup fails: a
   * template send is not worth failing over a greeting that would
   * render empty anyway.
   */
  private async withContactTokens(
    context: AutomationContext,
    contactId: string | null | undefined,
  ): Promise<AutomationContext> {
    if (!contactId || context.contact) return context;
    try {
      const contact = await this.prisma.contacts.findUnique({
        where: { id: contactId },
        select: { name: true, phone: true, email: true, company: true },
      });
      if (!contact) return context;
      return {
        ...context,
        contact: {
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          company: contact.company,
        },
      };
    } catch {
      return context;
    }
  }

  private async resolveConversationId(
    args: StepExecutionArgs,
  ): Promise<string> {
    const fromCtx = args.context.conversation_id;
    if (fromCtx) return fromCtx;
    if (!args.contactId) {
      // Skippable, not fatal — see NoReachableConversationError. A
      // form_submitted run with no identifiable person should still add
      // tags and fire webhooks.
      throw new NoReachableConversationError(
        null,
        'This step needs someone to message, and the trigger identified nobody. Skipped.',
      );
    }
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
      // The common cause is a contact created by a hosted form submission,
      // who has never been in a conversation on any channel. That is an
      // ordinary state, not an error, so the step is skipped and the run
      // continues.
      throw new NoReachableConversationError(
        args.contactId,
        channel
          ? `This contact has no ${channel} conversation, so the step was skipped.`
          : 'This contact has no conversation to message, so the step was skipped.',
      );
    }
    return convo.id;
  }

  /**
   * File a step's output under its key so later steps can read it as
   * `{{ steps.<key>.… }}`, and optionally copy it to a variable.
   *
   * KEYED BY `key`, NOT BY ROW ID
   *   Saving an automation is delete-then-reinsert, so ids change on
   *   every save and any token built on one would rot silently. A step
   *   with no key (a client that predates migration 080) simply
   *   publishes nothing — its output was unreferenceable anyway.
   *
   * Mutates `args.context` in place because that same object is what
   * gets persisted on a wait, so an output collected before a three-day
   * wait is still there when the run resumes.
   */
  private publishOutput(
    step: { key?: string | null; stepConfig: unknown },
    args: StepExecutionArgs,
    output: unknown,
  ): void {
    if (output === undefined) return;
    if (step.key) {
      args.context.steps = { ...(args.context.steps ?? {}), [step.key]: output };
    }
    const saveAs = (step.stepConfig as CommonStepOptions)?.save_as?.trim();
    if (saveAs) {
      args.context.vars = { ...(args.context.vars ?? {}), [saveAs]: output };
    }
  }

  /**
   * Which branch a `random_split` takes.
   *
   * Per RUN, not per contact: a contact who triggers the automation
   * twice can legitimately land in different halves. Sticky assignment
   * would need a stored bucket per contact, which is a different feature
   * (and a migration) — this one is honest A/B on traffic.
   */
  private rollSplit(cfg: RandomSplitStepConfig): boolean {
    const percent = Math.min(100, Math.max(0, Number(cfg.percent ?? 50)));
    return Math.random() * 100 < percent;
  }

  /** The contact's most recent deal, for `update_deal`'s default target. */
  private async latestDealIdForContact(
    args: StepExecutionArgs,
  ): Promise<string | null> {
    if (!args.contactId) return null;
    const deal = await this.prisma.deals.findFirst({
      where: {
        contact_id: args.contactId,
        account_id: args.automation.accountId,
      },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    return deal?.id ?? null;
  }

  /** Who a `notify_team` step writes notification rows for. */
  private async notifyRecipients(
    cfg: NotifyTeamStepConfig,
    args: StepExecutionArgs,
  ): Promise<string[]> {
    if (cfg.recipient === 'specific') {
      if (!cfg.user_id) return [];
      // Membership check, not a bare id: the id comes from config, and
      // notifications are keyed by (account, user) — writing one for a
      // user outside the workspace would surface this account's contact
      // and conversation ids in their notification list.
      const member = await this.prisma.profile.findFirst({
        where: {
          userId: cfg.user_id,
          accountId: args.automation.accountId,
        },
        select: { userId: true },
      });
      return member ? [member.userId] : [];
    }

    if (cfg.recipient === 'assigned_agent') {
      if (!args.contactId) return [];
      const convo = await this.prisma.conversations.findFirst({
        where: this.conversationScope(args),
        orderBy: { last_message_at: 'desc' },
        select: { assigned_agent_id: true },
      });
      return convo?.assigned_agent_id ? [convo.assigned_agent_id] : [];
    }

    const members = await this.prisma.profile.findMany({
      where: { accountId: args.automation.accountId },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  /**
   * A money/number config field, interpolated then coerced.
   *
   * Returns undefined for "leave it alone" so an update can distinguish
   * an omitted field from an explicit zero — `value: ""` on an update
   * must not silently zero a deal.
   */
  private toDecimal(
    raw: unknown,
    context: AutomationContext,
  ): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const text =
      typeof raw === 'string' ? interpolate(raw, context) : String(raw);
    const n = Number(text.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : undefined;
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

  /**
   * Milliseconds until the next `HH:mm` in the configured zone that also
   * falls on an allowed weekday.
   *
   * WHY THIS IS NOT `wait`
   *   "Reply at 9am" and "reply in 12 hours" are different rules and one
   *   cannot express the other: 12 hours after a 10pm message is 10am
   *   only if the message arrived at 10pm.
   *
   * TIMEZONE HANDLING
   *   Computed by formatting `now` into the target zone with Intl and
   *   measuring the offset from that — no dependency, and correct across
   *   a DST boundary because the offset is recomputed from the target
   *   instant rather than assumed constant.
   *
   *   An unknown zone falls back to UTC rather than to the server's local
   *   time: a silently different answer per deploy is worse than one
   *   documented default.
   */
  private waitUntilMs(cfg: WaitUntilStepConfig): number {
    const [rawH, rawM] = String(cfg.time ?? '09:00').split(':');
    const hour = Math.min(23, Math.max(0, Number(rawH) || 0));
    const minute = Math.min(59, Math.max(0, Number(rawM) || 0));
    const zone = cfg.timezone?.trim() || 'UTC';
    const allowedDays =
      Array.isArray(cfg.days) && cfg.days.length > 0
        ? new Set(cfg.days.map((d) => Number(d)))
        : null;

    const now = new Date();
    // Search day by day: at most a week, and it handles "Monday 9am"
    // from a Friday without any date arithmetic of our own.
    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      const candidate = this.zonedTimeToInstant(
        now,
        dayOffset,
        hour,
        minute,
        zone,
      );
      if (candidate.getTime() <= now.getTime()) continue;
      if (allowedDays && !allowedDays.has(this.weekdayIn(candidate, zone))) {
        continue;
      }
      return Math.max(1_000, candidate.getTime() - now.getTime());
    }
    // No allowed day in the next week (an empty `days` set that somehow
    // matched nothing). An hour is a safe, visible fallback — better than
    // a run that never resumes.
    return 3_600_000;
  }

  /**
   * Day of week (0=Sun) as it reads in `zone` at that instant.
   *
   * Matters near midnight: 23:30 UTC on Sunday is Monday in Sydney, and
   * a "weekdays only" wait must agree with the recipient's calendar.
   */
  private weekdayIn(at: Date, zone: string): number {
    const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    try {
      const label = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'short',
      }).format(at);
      const index = NAMES.indexOf(label);
      return index === -1 ? at.getUTCDay() : index;
    } catch {
      return at.getUTCDay();
    }
  }

  /**
   * The instant at which the wall clock in `zone` reads `hour:minute`,
   * `dayOffset` days from today.
   *
   * Two-pass: guess in UTC, measure how far that guess lands from the
   * wanted wall-clock time in the target zone, then correct. One
   * correction is enough for every real zone (offsets are whole minutes).
   */
  private zonedTimeToInstant(
    now: Date,
    dayOffset: number,
    hour: number,
    minute: number,
    zone: string,
  ): Date {
    const parts = (d: Date) => {
      try {
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
        const map: Record<string, number> = {};
        for (const p of fmt.formatToParts(d)) {
          if (p.type !== 'literal') map[p.type] = Number(p.value);
        }
        return map;
      } catch {
        // Unknown zone — treat as UTC (see waitUntilMs).
        return {
          year: d.getUTCFullYear(),
          month: d.getUTCMonth() + 1,
          day: d.getUTCDate(),
          hour: d.getUTCHours(),
          minute: d.getUTCMinutes(),
          second: d.getUTCSeconds(),
        };
      }
    };

    const today = parts(now);
    let guess = new Date(
      Date.UTC(today.year, today.month - 1, today.day + dayOffset, hour, minute, 0),
    );
    const atGuess = parts(guess);
    const wantedMinutes = hour * 60 + minute;
    const actualMinutes = atGuess.hour * 60 + atGuess.minute;
    // Difference wraps at midnight; normalise into ±12h.
    let deltaMinutes = wantedMinutes - actualMinutes;
    if (deltaMinutes > 720) deltaMinutes -= 1440;
    if (deltaMinutes < -720) deltaMinutes += 1440;
    guess = new Date(guess.getTime() + deltaMinutes * 60_000);
    return guess;
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
