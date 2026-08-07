import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import { sendTemplateMessage } from '../meta-api.util';
import {
  MetaApiError,
  MetaRateLimitError,
} from '../../common/messaging/meta-errors';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '../../v1/utils/phone.util';
import {
  resolveBroadcastVariables,
  resolveBroadcastVariableMap,
  type VariableMapping,
} from '../services/dashboard-broadcast.service';
import {
  parseBroadcastTemplateConfig,
  toMessageParams,
} from './broadcast-template.util';

/** Raised when the broadcast as a whole cannot proceed, not just this recipient. */
export class BroadcastUnsendableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BroadcastUnsendableError';
  }
}

export type RecipientOutcome =
  /** Delivered to Meta; `whatsapp_message_id` recorded. */
  | { status: 'sent'; messageId: string }
  /** Permanently undeliverable — recorded on the row, never retried. */
  | { status: 'failed'; error: string }
  /** Already handled (not pending any more, or the broadcast is over). */
  | { status: 'skipped'; reason: string };

/**
 * Is this worth another attempt, or is retrying just going to fail
 * identically five more times?
 *
 * The distinction matters more here than in a normal HTTP call site: a
 * broadcast has thousands of these, so retrying the un-retryable turns
 * a fast, honest failure report into twenty minutes of exponential
 * backoff during which the customer watches a progress bar not move.
 *
 * Transient: throttling (Meta says "slow down", which is a scheduling
 * problem, not a message problem), any 5xx, and network-level failures
 * where `fetch` rejects without a response at all.
 *
 * Permanent: everything Meta rejected on the merits — an unapproved
 * template, a malformed parameter, a number that cannot receive
 * template messages. Those are content, and the content will not
 * change between attempt one and attempt five.
 */
export function isTransientSendError(err: unknown): boolean {
  if (err instanceof MetaRateLimitError) return true;
  if (err instanceof MetaApiError) {
    return err.status !== undefined && err.status >= 500;
  }
  // fetch() rejects with a TypeError for DNS/connection/TLS failures,
  // and AbortError when a timeout fires. Neither carries a status.
  if (err instanceof Error) {
    return (
      err.name === 'AbortError' ||
      err.name === 'TimeoutError' ||
      err.name === 'FetchError' ||
      err instanceof TypeError
    );
  }
  return false;
}

/**
 * Sends exactly one broadcast recipient.
 *
 * Everything it needs is re-read from the database on every call, and
 * that is deliberate:
 *
 * - The access token must never sit in a BullMQ payload. Job data lives
 *   in Redis in plaintext and is displayed in the queue dashboard.
 * - A job may run minutes after it was queued, on a different process,
 *   after a token rotation or a template edit. Reading now is the only
 *   way to be sending what the account currently has.
 * - Retries and resumes have to rebuild the send identically from
 *   durable state alone.
 *
 * The cost is a handful of indexed reads per recipient. The send queue
 * is rate limited to ~10 jobs/second, so that is single-digit queries
 * per second against Postgres — cheaper than one page render.
 */
@Injectable()
export class BroadcastRecipientSendService {
  private readonly logger = new Logger(BroadcastRecipientSendService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sendOne(
    broadcastId: string,
    recipientId: string,
  ): Promise<RecipientOutcome> {
    const recipient = await this.prisma.broadcast_recipients.findUnique({
      where: { id: recipientId },
      select: {
        id: true,
        status: true,
        broadcast_id: true,
        template_params: true,
        contacts: {
          select: {
            id: true,
            phone: true,
            name: true,
            email: true,
            company: true,
          },
        },
      },
    });

    // Not pending → someone already sent it. This is the idempotency
    // guard that makes BullMQ's at-least-once delivery safe: a job
    // redelivered because the worker died after sending but before
    // acknowledging finds the row already marked and does nothing.
    if (!recipient) return { status: 'skipped', reason: 'recipient gone' };
    if (recipient.status !== 'pending') {
      return { status: 'skipped', reason: `already ${recipient.status}` };
    }

    const broadcast = await this.prisma.broadcasts.findUnique({
      where: { id: broadcastId },
      select: {
        id: true,
        account_id: true,
        status: true,
        template_name: true,
        template_language: true,
        template_variables: true,
      },
    });
    if (!broadcast) return { status: 'skipped', reason: 'broadcast gone' };
    if (broadcast.status !== 'sending' && broadcast.status !== 'queued') {
      return { status: 'skipped', reason: `broadcast is ${broadcast.status}` };
    }

    const contact = recipient.contacts;
    if (!contact?.phone) {
      return { status: 'failed', error: 'No phone number on contact' };
    }
    const sanitized = sanitizePhoneForMeta(contact.phone);
    if (!isValidE164(sanitized)) {
      return { status: 'failed', error: 'Invalid phone number' };
    }

    const config = await this.prisma.whatsapp_config.findFirst({
      where: { account_id: broadcast.account_id },
      select: { phone_number_id: true, access_token: true },
    });
    if (!config) {
      throw new BroadcastUnsendableError('WhatsApp not configured');
    }
    let accessToken: string;
    try {
      accessToken = decrypt(config.access_token);
    } catch {
      throw new BroadcastUnsendableError(
        'Failed to decrypt WhatsApp access token',
      );
    }

    const templateRow = await this.prisma.message_templates.findFirst({
      where: {
        account_id: broadcast.account_id,
        name: broadcast.template_name,
        language: broadcast.template_language,
      },
    });
    const isNamedTemplate =
      (templateRow as { parameter_format?: string } | null)
        ?.parameter_format === 'NAMED';

    const templateConfig = parseBroadcastTemplateConfig(
      broadcast.template_variables,
    );

    // Two sources of parameters, one send path.
    //
    // The public API sends explicit per-recipient values, persisted on
    // the row (migration 070). The dashboard sends a mapping —
    // "variable 1 is the contact's name" — resolved per contact here.
    // A row with template_params always wins; it exists only when the
    // API wrote it.
    const explicitParams = asStringArray(recipient.template_params);
    let params: string[] | undefined;
    let bodyNamed: Record<string, string> | undefined;

    if (explicitParams) {
      params = explicitParams;
    } else {
      const customValues = await this.loadCustomValues(
        contact.id,
        templateConfig.variables,
      );
      // NAMED templates travel as a name → value map; positional ones
      // keep the ordered array. Meta matches named parameters by name,
      // so handing over a map sidesteps the ordering question the
      // array form cannot answer.
      if (isNamedTemplate) {
        bodyNamed = resolveBroadcastVariableMap(
          templateConfig.variables,
          contact,
          customValues,
        );
      } else {
        params = resolveBroadcastVariables(
          templateConfig.variables,
          contact,
          customValues,
        );
      }
    }

    const messageParams = toMessageParams(templateConfig, bodyNamed);

    let lastError: unknown = null;
    for (const variant of phoneVariants(sanitized)) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: variant,
          templateName: broadcast.template_name,
          language: broadcast.template_language,
          template: (templateRow as never) ?? undefined,
          params,
          messageParams,
        });
        return { status: 'sent', messageId: result.messageId };
      } catch (error) {
        lastError = error;
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        // Only "not allowed" is worth trying the other spelling of the
        // number for — every other rejection would fail identically.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    // Transient failures propagate so BullMQ's backoff owns the retry
    // and the row stays 'pending' — resumable. Permanent ones are
    // recorded here and never tried again.
    if (isTransientSendError(lastError)) {
      throw lastError;
    }
    return {
      status: 'failed',
      error:
        lastError instanceof Error ? lastError.message : 'Unknown send error',
    };
  }

  /**
   * Custom-field values for one contact, and only when the template
   * actually maps one. The common case — a broadcast using {{1}} =
   * contact name — reads nothing at all.
   */
  private async loadCustomValues(
    contactId: string,
    variables: Record<string, VariableMapping>,
  ): Promise<Map<string, string> | undefined> {
    const needed = Object.values(variables).some(
      (v) => v && typeof v === 'object' && v.type === 'custom_field',
    );
    if (!needed) return undefined;

    const rows = await this.prisma.contact_custom_values.findMany({
      where: { contact_id: contactId },
      select: { custom_field_id: true, value: true },
    });
    return new Map(rows.map((r) => [r.custom_field_id, r.value ?? '']));
  }

  /** Record the outcome on the recipient row. Never throws. */
  async markRecipient(
    recipientId: string,
    outcome: RecipientOutcome,
  ): Promise<void> {
    if (outcome.status === 'skipped') return;
    try {
      await this.prisma.broadcast_recipients.update({
        where: { id: recipientId },
        data:
          outcome.status === 'sent'
            ? {
                status: 'sent',
                sent_at: new Date(),
                whatsapp_message_id: outcome.messageId,
                error_message: null,
              }
            : { status: 'failed', error_message: outcome.error.slice(0, 500) },
      });
    } catch (err) {
      this.logger.error(
        `failed updating recipient ${recipientId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * `template_params` is Json, so it can be anything the API accepted
 * historically. Only an array of strings is usable as positional
 * template parameters; anything else means "no explicit params" rather
 * than a crash mid-broadcast.
 */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}
