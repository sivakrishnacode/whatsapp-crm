import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import { FormContactResolverService } from './form-contact-resolver.service';
import { BookingService } from './booking.service';
import { validateSubmission } from '../form-validate';
import type { FormField, FormSettings } from '../form.types';

export interface SubmitFormInput {
  accountId: string;
  ownerUserId: string;
  formId: string;
  fields: FormField[];
  settings: FormSettings;
  answers: Record<string, unknown>;
  source:
    'hosted' | 'embed' | 'widget' | 'whatsapp_flow' | 'api' | 'automation';
  /** Widget submissions carry these, so a reply lands in the live thread. */
  contactId?: string | null;
  conversationId?: string | null;
  meta?: {
    pageUrl?: string;
    referrer?: string;
    utm?: Record<string, unknown>;
    userAgent?: string;
    ip?: string;
  };
  /** Anti-spam signals from the renderer. */
  spam?: {
    /** The honeypot field's value. Non-empty means a bot filled it. */
    honeypot?: string;
    /** Milliseconds between render and submit. */
    elapsedMs?: number;
  };
}

export interface SubmitFormResult {
  submissionId: string;
  contactId: string | null;
  successMode: 'message' | 'redirect';
  successMessage: string;
  redirectUrl: string | null;
  /** Present when the form carried a slot picker and a slot was reserved. */
  booking?: {
    id: string;
    starts_at: string;
    ends_at: string;
    timezone: string;
    manage_url: string;
  };
}

/**
 * The public submission path.
 *
 * ORDER: validate → spam-check → persist → resolve contact → dispatch
 *
 *   Persisting BEFORE contact resolution is deliberate. Resolution touches
 *   several tables and can decline a merge; if it threw, a
 *   submit-then-resolve order would have already stored the lead, whereas
 *   a resolve-then-submit order would lose it. A lead in the table with a
 *   null contact_id is recoverable by hand; a lead that was never stored
 *   is gone.
 *
 * SPAM CONTROLS ARE CHEAP AND STACKED
 *   None of the three is strong alone; together they stop essentially all
 *   drive-by form spam without ever showing a human a puzzle. A real
 *   CAPTCHA is opt-in per form because it costs conversions.
 */
@Injectable()
export class FormSubmitService {
  private readonly logger = new Logger(FormSubmitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: FormContactResolverService,
    private readonly automationDispatch: AutomationDispatchService,
    private readonly webhookDeliver: WebhookDeliverService,
    private readonly booking: BookingService,
  ) {}

  async submit(input: SubmitFormInput): Promise<SubmitFormResult> {
    this.assertNotSpam(input);

    const validation = validateSubmission(input.fields, input.answers);
    if (!validation.ok) {
      throw new BadRequestException({
        message: 'Please check the highlighted fields.',
        errors: validation.errors,
      });
    }

    const submission = await this.prisma.form_submissions.create({
      data: {
        account_id: input.accountId,
        form_id: input.formId,
        conversation_id: input.conversationId ?? null,
        contact_id: input.contactId ?? null,
        data: validation.data as Prisma.InputJsonValue,
        source: input.source,
        meta: this.buildMeta(input) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    // Denormalised counter — see the migration's note on why.
    await this.prisma.forms.update({
      where: { id: input.formId },
      data: { submission_count: { increment: 1 } },
    });

    let contactId = input.contactId ?? null;
    try {
      const resolved = await this.resolver.resolve({
        accountId: input.accountId,
        ownerUserId: input.ownerUserId,
        fields: input.fields,
        data: validation.data,
        existingContactId: input.contactId,
      });
      contactId = resolved.contactId;

      if (contactId) {
        await this.prisma.form_submissions.update({
          where: { id: submission.id },
          data: { contact_id: contactId },
        });
        if (!resolved.created) {
          // A newly created contact already had its custom values written
          // inside resolve(); an attached one has not.
          await this.resolver.applyCustomFields(
            {
              accountId: input.accountId,
              ownerUserId: input.ownerUserId,
              fields: input.fields,
              data: validation.data,
            },
            contactId,
          );
        }
      }
    } catch (err) {
      // The lead is already stored. Log loudly and carry on rather than
      // returning an error to a visitor who did nothing wrong.
      this.logger.error(
        `contact resolution failed for submission ${submission.id}: ${String(err)}`,
      );
    }

    /**
     * Reserve the slot, if this form takes bookings.
     *
     * AFTER the submission and the contact, and NOT fire-and-forget.
     *
     *   After, because the booking row references the submission — and
     *   because if the slot has gone, the answers are still worth keeping as a
     *   lead even though the reservation failed.
     *
     *   Awaited, unlike the automation fan-out, because the customer has to be
     *   told. "Thanks, you're booked for 3pm" versus "that time just went,
     *   pick another" is the entire outcome of the interaction, and it cannot
     *   be delivered later over a channel a hosted-page visitor does not have.
     */
    let booking: SubmitFormResult['booking'];
    const slotField = BookingService.slotField(input.fields);
    if (slotField) {
      const chosen = validation.data[slotField.field_key];
      if (typeof chosen === 'string') {
        const reserved = await this.booking.book({
          accountId: input.accountId,
          formId: input.formId,
          submissionId: submission.id,
          contactId,
          conversationId: input.conversationId ?? null,
          startIso: chosen,
        });
        booking = {
          id: reserved.id,
          starts_at: reserved.starts_at,
          ends_at: reserved.ends_at,
          timezone: reserved.timezone,
          manage_url: reserved.manage_url,
        };
      }
    }

    void this.fanOut(input, submission.id, contactId, validation.data);

    return {
      submissionId: submission.id,
      contactId,
      successMode: input.settings.success_mode,
      successMessage: input.settings.success_message,
      redirectUrl: input.settings.redirect_url,
      booking,
    };
  }

  /**
   * Three stacked heuristics. All are silent to a human filling the form
   * honestly, and all are cheap enough to run on every submission.
   */
  private assertNotSpam(input: SubmitFormInput): void {
    // 1. Honeypot: a field hidden with CSS that no human can see. Bots fill
    //    every input they find.
    if (input.settings.honeypot && input.spam?.honeypot?.trim()) {
      this.logger.warn(`honeypot tripped on form ${input.formId}`);
      // Same 400 as a validation failure. Telling a bot it was detected
      // just tells its author which signal to defeat next.
      throw new BadRequestException({
        message: 'Please check the highlighted fields.',
        errors: [],
      });
    }

    // 2. Time-to-submit: nobody reads and fills a form in under a second.
    const minMs = Math.max(0, input.settings.min_seconds) * 1000;
    if (
      minMs > 0 &&
      input.spam?.elapsedMs !== undefined &&
      input.spam.elapsedMs < minMs
    ) {
      this.logger.warn(
        `form ${input.formId} submitted in ${input.spam.elapsedMs}ms (min ${minMs}ms)`,
      );
      throw new BadRequestException({
        message: 'That was too quick — please try again.',
        errors: [],
      });
    }

    // 3. Per-IP rate limiting happens in the controller, where the request
    //    context lives.
  }

  private buildMeta(input: SubmitFormInput): Record<string, unknown> {
    const salt =
      process.env.WEB_IP_HASH_SALT ?? process.env.ENCRYPTION_KEY ?? '';
    return {
      ...(input.meta?.pageUrl ? { page_url: input.meta.pageUrl } : {}),
      ...(input.meta?.referrer ? { referrer: input.meta.referrer } : {}),
      ...(input.meta?.utm ? { utm: input.meta.utm } : {}),
      ...(input.meta?.userAgent
        ? { user_agent: input.meta.userAgent.slice(0, 500) }
        : {}),
      // Hashed, never raw. Same reasoning as web_sessions.ip_hash: needed
      // for abuse forensics, not worth storing as a PII-grade identifier.
      ...(input.meta?.ip
        ? {
            ip_hash: createHash('sha256')
              .update(`${salt}:${input.meta.ip}`)
              .digest('hex'),
          }
        : {}),
    };
  }

  /**
   * Notify the engines. Never awaited by the caller — the visitor's
   * "thanks" page must not wait on an automation, and their submission is
   * already stored.
   */
  private async fanOut(
    input: SubmitFormInput,
    submissionId: string,
    contactId: string | null,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.automationDispatch.enqueue({
        accountId: input.accountId,
        triggerType: 'form_submitted',
        contactId,
        context: {
          form_id: input.formId,
          submission_id: submissionId,
          // `source` is not part of AutomationContext; the webhook payload
          // (below) carries it for analytics, but the automation engine
          // doesn't need to know which channel a form came from.
          ...(input.conversationId
            ? { conversation_id: input.conversationId }
            : {}),
          // Answers are exposed as `{{ vars.form.<field_key> }}` so a
          // follow-up message can quote what the person actually said.
          form: data,
        },
      });
    } catch (err) {
      this.logger.error(
        `[automations] form_submitted dispatch failed for ${submissionId}: ${String(err)}`,
      );
    }

    void this.webhookDeliver.dispatchWebhookEvent(
      input.accountId,
      'form.submitted',
      {
        form_id: input.formId,
        submission_id: submissionId,
        contact_id: contactId,
        source: input.source,
        data,
      },
    );
  }
}
