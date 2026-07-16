import { Injectable, Logger } from '@nestjs/common';
import type { Automation } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationStepExecutorService } from './automation-step-executor.service';
import { triggerMatches } from './automation-trigger-match.util';
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
  ) {}

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

      for (const automation of automations) {
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
      context: (pending.context ?? {}) as AutomationContext,
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
