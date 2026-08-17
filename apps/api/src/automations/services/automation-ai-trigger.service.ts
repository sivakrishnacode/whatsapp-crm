import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { AUTOMATION_TRIGGER_QUEUE } from '../../queue/queue.constants';
import type { AutomationDispatchInput } from '../automation.types';

/**
 * ============================================================
 * Safe automation trigger service for AI agents.
 *
 * Wraps the automation dispatch logic to allow AI agents to
 * trigger automations safely, with proper account scoping and
 * validation. Every trigger is queued, never run inline.
 * ============================================================
 */

export interface AiAutomationTriggerInput {
  accountId: string;
  contactId: string | null;
  triggerType: string;
  conversationId?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AutomationAiTriggerService {
  private readonly logger = new Logger(AutomationAiTriggerService.name);

  /** Whitelisted trigger types that AI agents are permitted to fire. */
  private readonly ALLOWED_TRIGGER_TYPES = [
    'form_submitted',
    'message_received',
    'contact_tagged',
    'conversation_started',
    'appointment_scheduled',
    'appointment_completed',
    'appointment_cancelled',
  ];

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(AUTOMATION_TRIGGER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Safely trigger an automation from an AI agent.
   *
   * - Only whitelisted trigger types are permitted
   * - Account scoping is enforced
   * - Contact is validated if provided
   * - Trigger is queued, never run inline
   */
  async triggerFromAgent(input: AiAutomationTriggerInput): Promise<{
    ok: boolean;
    detail: string;
  }> {
    // Validate trigger type
    if (!input.triggerType?.trim()) {
      return { ok: false, detail: 'Automation trigger type is required.' };
    }

    const triggerType = input.triggerType.toLowerCase();

    if (!this.ALLOWED_TRIGGER_TYPES.includes(triggerType)) {
      return {
        ok: false,
        detail: `Trigger type "${triggerType}" is not allowed. Permitted types: ${this.ALLOWED_TRIGGER_TYPES.join(', ')}`,
      };
    }

    // Validate account
    if (!input.accountId?.trim()) {
      return { ok: false, detail: 'Account ID is required.' };
    }

    // Validate contact if provided
    if (input.contactId) {
      const contact = await this.prisma.contacts.findFirst({
        where: { id: input.contactId, account_id: input.accountId },
        select: { id: true },
      });

      if (!contact) {
        this.logger.warn(
          `AI trigger: contact ${input.contactId} not found in account ${input.accountId}`,
        );
        return {
          ok: false,
          detail: 'Contact not found in this account. Unable to trigger automation.',
        };
      }
    }

    // Build dispatch input
    const dispatchInput: AutomationDispatchInput = {
      accountId: input.accountId,
      triggerType,
      contactId: input.contactId || undefined,
      context: {
        conversation_id: input.conversationId,
        vars: input.metadata,
      },
    };

    try {
      // Queue the automation trigger (never run inline)
      await this.queue.add('trigger', dispatchInput, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 200, age: 3600 },
        removeOnFail: { count: 500 },
      });

      this.logger.log(
        `AI automation trigger queued: ${triggerType} for contact ${input.contactId || 'N/A'} on account ${input.accountId}`,
      );

      return {
        ok: true,
        detail: `Automation trigger "${triggerType}" has been queued and will be processed shortly.`,
      };
    } catch (error) {
      this.logger.error(
        `Failed to queue automation trigger: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return {
        ok: false,
        detail: `Failed to trigger automation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Get a list of automation trigger types available for this account.
   */
  async getAvailableTriggerTypes(accountId: string): Promise<{
    ok: boolean;
    triggers: Array<{ type: string; label: string; description: string }>;
  }> {
    try {
      // Count active automations by trigger type for this account
      const automations = await this.prisma.automation.findMany({
        where: { accountId, isActive: true },
        select: { triggerType: true },
      });

      const triggerTypeCounts = new Map<string, number>();
      for (const auto of automations) {
        const count = triggerTypeCounts.get(auto.triggerType) || 0;
        triggerTypeCounts.set(auto.triggerType, count + 1);
      }

      // Map trigger types to friendly labels
      const triggerDescriptions: Record<string, { label: string; description: string }> = {
        form_submitted: {
          label: 'Form submitted',
          description: 'When a customer submits a web form',
        },
        message_received: {
          label: 'Message received',
          description: 'When a message arrives from a customer',
        },
        contact_tagged: {
          label: 'Contact tagged',
          description: 'When a contact is assigned a tag',
        },
        conversation_started: {
          label: 'Conversation started',
          description: 'When a new conversation is initiated',
        },
        appointment_scheduled: {
          label: 'Appointment scheduled',
          description: 'When an appointment is booked',
        },
        appointment_completed: {
          label: 'Appointment completed',
          description: 'When an appointment is finished',
        },
        appointment_cancelled: {
          label: 'Appointment cancelled',
          description: 'When an appointment is cancelled',
        },
      };

      const results = this.ALLOWED_TRIGGER_TYPES.map((type) => ({
        type,
        label: triggerDescriptions[type]?.label || type,
        description: triggerDescriptions[type]?.description || `${type} trigger`,
        active: triggerTypeCounts.has(type),
        automationCount: triggerTypeCounts.get(type) || 0,
      }));

      return {
        ok: true,
        triggers: results,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get automation triggers: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return {
        ok: false,
        triggers: [],
      };
    }
  }
}
