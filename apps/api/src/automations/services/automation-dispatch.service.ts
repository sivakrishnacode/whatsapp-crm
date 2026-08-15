import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Automation } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationStepExecutorService } from './automation-step-executor.service';
import { triggerMatches } from './automation-trigger-match.util';
import { toChannel } from '../../common/messaging/channel';
import { AUTOMATION_TRIGGER_QUEUE } from '../../queue/queue.constants';
import { CHANNELLESS_TRIGGERS } from '../automation.types';
import type {
  AutomationContext,
  AutomationDispatchInput,
} from '../automation.types';

/**
 * Ported from apps/web/src/lib/automations/engine.ts's `runAutomationsForTrigger()`
 * + `resumePendingExecution()` — the engine's two public entry points.
 */
@Injectable()
export class AutomationDispatchService {
  private readonly logger = new Logger(AutomationDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stepExecutor: AutomationStepExecutorService,
    @InjectQueue(AUTOMATION_TRIGGER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Queue a trigger instead of running it inline.
   *
   * `dispatch()` can run an entire automation — sending messages,
   * calling webhooks, waiting — and the callers that reach it from a
   * form submission, a web-widget message or a booking were doing that
   * inside the request that caused it. A slow automation therefore
   * slowed down the visitor's own page, and a restart mid-run lost the
   * remainder with no way to tell it had ever started.
   *
   * The input is ids and a plain-JSON context, so a queued trigger runs
   * exactly as it would have inline — just not on the caller's clock.
   * Never throws: every caller is a fire-and-forget fan-out, and a
   * Redis blip must not fail the form submission that triggered it.
   */
  async enqueue(input: AutomationDispatchInput): Promise<void> {
    try {
      await this.queue.add('trigger', input, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 200, age: 3600 },
        removeOnFail: { count: 500 },
      });
    } catch (err) {
      this.logger.error(
        `could not queue ${input.triggerType} trigger: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fire all active automations matching the given trigger for an account.
   *
   * Must never throw — callers use fire-and-forget from the webhook (via
   * the internal dispatch bridge). All errors are caught and logged;
   * per-automation failures are recorded into automation_logs with
   * status='failed'.
   */
  async dispatch(input: AutomationDispatchInput): Promise<void> {
    try {
      // Tenant isolation. `contactId` can be caller-supplied (the manual
      // POST /automations/engine entrypoint reads it straight from the
      // request body, as does the internal webhook bridge), and every
      // step below runs through the bypassrls Prisma connection. So
      // before any step can touch the contact, verify it actually
      // belongs to this account. A foreign or forged id is refused
      // silently — callers are fire-and-forget, and a distinct error
      // would leak whether a given contact UUID exists.
      if (input.contactId) {
        const owned = await this.prisma.contacts.findFirst({
          where: { id: input.contactId, account_id: input.accountId },
          select: { id: true },
        });
        if (!owned) {
          this.logger.warn(
            `contact not in account, refusing dispatch: ${input.contactId}`,
          );
          return;
        }
      }

      const automations = await this.prisma.automation.findMany({
        where: {
          accountId: input.accountId,
          triggerType: input.triggerType,
          isActive: true,
        },
      });
      if (automations.length === 0) return;

      // The channel the event came from. WhatsApp's webhook predates
      // the field and omits it, so absent means WhatsApp — `toChannel`
      // owns that default rather than each call site guessing.
      const eventChannel = toChannel(input.context?.channel);

      // Some events have no channel AT ALL, and for those the default
      // above is an artefact rather than a fact — see CHANNELLESS_TRIGGERS.
      const channelScoped = !CHANNELLESS_TRIGGERS.has(input.triggerType);

      for (const automation of automations) {
        // Channel scoping. An EMPTY `channels` array means "no
        // restriction" — the default, and what every automation
        // predating the column carries — so this only ever narrows.
        if (channelScoped && automation.channels.length > 0) {
          if (!automation.channels.includes(eventChannel)) {
            continue;
          }
        }

        if (
          !triggerMatches(
            automation.triggerType,
            automation.triggerConfig,
            input.context,
          )
        )
          continue;
        try {
          await this.executeAutomation(automation, input);
        } catch (err) {
          this.logger.error(
            `execute failed: ${automation.id}`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }
    } catch (err) {
      this.logger.error(
        'dispatch failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Resume a run that was parked at a wait step. Called from the BullMQ processor. */
  /**
   * True when a held run is about a booking that is no longer valid.
   *
   * "No longer valid" is deliberately narrow: cancelled, deleted, or
   * MOVED. A reschedule changes `starts_at`, which means the reminder was
   * scheduled against the old time and would arrive at the wrong moment —
   * the reschedule fires its own `appointment_rescheduled` trigger, so a
   * correctly-timed reminder can be scheduled from that instead.
   *
   * Fails OPEN: a lookup that errors returns false and the run proceeds.
   * A missed reminder is a worse outcome than a slightly stale one, and
   * this must never become a way for a database blip to silence
   * automations that have nothing to do with bookings.
   */
  private async bookingWentAway(context: AutomationContext): Promise<boolean> {
    const appointmentId = context?.appointment_id;
    if (typeof appointmentId !== 'string' || !appointmentId) return false;

    try {
      const booking = await this.prisma.form_bookings.findUnique({
        where: { id: appointmentId },
        select: { status: true, starts_at: true },
      });
      if (!booking) return true;
      if (booking.status !== 'confirmed') return true;

      const scheduledFor = (
        context.vars as { booking?: { starts_at?: unknown } } | undefined
      )?.booking?.starts_at;
      if (typeof scheduledFor === 'string') {
        const then = new Date(scheduledFor).getTime();
        if (
          !Number.isNaN(then) &&
          Math.abs(then - booking.starts_at.getTime()) > 60_000
        ) {
          return true;
        }
      }
      return false;
    } catch (err) {
      this.logger.warn(
        `resume: could not verify booking ${appointmentId}, proceeding: ${String(err)}`,
      );
      return false;
    }
  }

  async resume(pendingExecutionId: string): Promise<void> {
    const pending = await this.prisma.automationPendingExecution.findUnique({
      where: { id: pendingExecutionId },
    });
    if (!pending) {
      // Cascade-deleted (e.g. the automation was removed) — nothing to do.
      return;
    }
    // Idempotency guard: BullMQ's at-least-once delivery can redeliver a
    // job whose worker crashed after finishing but before acknowledging.
    // Replaces the old DB-CAS "claim" dance entirely.
    if (pending.status !== 'pending') {
      return;
    }

    const automation = await this.prisma.automation.findUnique({
      where: { id: pending.automationId },
    });
    if (!automation) {
      this.logger.error(`resume: missing automation ${pending.automationId}`);
      await this.markPending(pending.id, 'failed');
      return;
    }

    /*
     * A held run can outlive the thing it is about.
     *
     * A reminder scheduled for "30 minutes before the appointment" sits in
     * the queue for days. If the customer cancels or moves the booking in
     * the meantime, firing it anyway sends "your meeting starts in 30
     * minutes" for a meeting that is not happening — worse than sending
     * nothing, because the customer may turn up.
     *
     * The context records `appointment_id` (BookingService.fanOut), so
     * this can be checked cheaply and only for runs that are about a
     * booking. Everything else is unaffected.
     */
    const context = (pending.context ?? {}) as AutomationContext;
    if (await this.bookingWentAway(context)) {
      this.logger.log(
        `resume: booking ${String(context.appointment_id)} is cancelled or moved, dropping held run ${pending.id}`,
      );
      // 'done', not 'failed': nothing went wrong. The run reached its
      // conclusion early because its subject went away.
      await this.markPending(pending.id, 'done');
      return;
    }

    // Deliberately NOT try/caught here: executeStepsFrom already swallows
    // and logs every *business* step failure into automation_logs (a
    // step throwing is a normal, expected outcome — see its per-step
    // try/catch) and returns normally either way. Anything that escapes
    // this call is therefore an actual infrastructure fault (a DB blip
    // hitting the steps query, appendResults, etc.) — exactly what
    // should propagate to the BullMQ processor so its attempts/backoff
    // can retry. The processor marks this row 'failed' only once
    // retries are exhausted (see markResumeFailed).
    await this.stepExecutor.executeStepsFrom({
      automation: {
        id: automation.id,
        accountId: automation.accountId,
        userId: automation.userId,
      },
      contactId: pending.contactId,
      context,
      parentStepId: pending.parentStepId,
      branch: pending.branch as 'yes' | 'no' | null,
      startPosition: pending.nextStepPosition,
      logId: pending.logId,
      triggerEvent: 'resumed_wait',
    });
    await this.markPending(pending.id, 'done');
  }

  /** Called by the BullMQ processor once retries for a resume job are exhausted. */
  async markResumeFailed(pendingExecutionId: string): Promise<void> {
    await this.markPending(pendingExecutionId, 'failed');
  }

  private async executeAutomation(
    automation: Automation,
    input: AutomationDispatchInput,
  ): Promise<void> {
    const log = await this.prisma.automationLog
      .create({
        data: {
          automationId: automation.id,
          // Tenancy: matches automation.accountId (NOT NULL post-017).
          accountId: automation.accountId,
          // Audit: keeps the historical "author of this automation"
          // pointer so logs still attribute to the right user even
          // after teammates join the account.
          userId: automation.userId,
          contactId: input.contactId ?? null,
          triggerEvent: input.triggerType,
          // NULL when the event carried no channel. Deliberately not
          // defaulted to 'whatsapp' — "unknown" and "WhatsApp" are
          // different answers to "why did this fire?".
          channel: input.context?.channel ?? null,
          stepsExecuted: [],
          status: 'success',
        },
      })
      .catch((err: unknown) => {
        this.logger.error(
          'cannot create log',
          err instanceof Error ? err.stack : String(err),
        );
        return null;
      });

    if (!log) return;

    await this.stepExecutor.executeStepsFrom({
      automation: {
        id: automation.id,
        accountId: automation.accountId,
        userId: automation.userId,
      },
      contactId: input.contactId ?? null,
      context: input.context ?? {},
      parentStepId: null,
      branch: null,
      startPosition: 0,
      logId: log.id,
      triggerEvent: input.triggerType,
    });

    // Atomic counter update — a client-side read-modify-write would race
    // when the same automation fires for two contacts simultaneously
    // (both read N, both write N+1, losing one count permanently).
    // Prisma's `increment` compiles to a single atomic SQL UPDATE.
    await this.prisma.automation
      .update({
        where: { id: automation.id },
        data: { executionCount: { increment: 1 }, lastExecutedAt: new Date() },
      })
      .catch((err: unknown) => {
        this.logger.error(
          'increment counter failed',
          err instanceof Error ? err.stack : String(err),
        );
      });
  }

  private async markPending(
    id: string,
    status: 'done' | 'failed',
  ): Promise<void> {
    await this.prisma.automationPendingExecution.update({
      where: { id },
      data: { status },
    });
  }
}
