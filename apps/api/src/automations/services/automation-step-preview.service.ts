import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationStepExecutorService } from './automation-step-executor.service';
import {
  interpolate,
  interpolateDeep,
  resolveValue,
} from './automation-interpolation.util';
import { redactUrl } from './automation-http.util';
import { interpolateAppActionInput } from './automation-app-action.util';
import { ConnectorRegistryService } from '../../connections/services/connector-registry.service';
import type {
  AutomationContext,
  AutomationStepType,
  SendWebhookStepConfig,
} from '../automation.types';

/**
 * "What would this step actually do?" — the editor's Test tab.
 *
 * TWO MODES, AND THE DIFFERENCE IS THE WHOLE POINT
 *   `preview` resolves every token against real sample data and returns
 *   the exact payload, WITHOUT sending anything. It is the default
 *   because the alternative — testing a Send message step by messaging a
 *   customer — costs money and reaches a real person who did not ask for
 *   it.
 *
 *   `run` executes the step for real, once, against a chosen contact.
 *   Behind an explicit button, never the default.
 *
 * WHY THIS LIVES IN THE API AND NOT THE BROWSER
 *   A preview that resolves tokens with its own copy of the rules will
 *   drift from the engine, and the day it does it will be reassuring
 *   about something that is broken. This calls the SAME
 *   `interpolate` / `interpolateDeep` the executor calls, so a preview
 *   that looks right cannot be wrong about the resolution.
 */
@Injectable()
export class AutomationStepPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: AutomationStepExecutorService,
    /** `app_action` previews resolve inputs against the action's FieldSpec. */
    private readonly connectors: ConnectorRegistryService,
  ) {}

  /**
   * Sample context for a preview: a real contact, their latest message
   * and conversation, plus the outputs recorded for earlier steps on the
   * most recent run of this automation.
   *
   * Real data throughout. Invented sample values ("John Doe") would let
   * somebody build a body around a field shape that does not exist.
   */
  async buildSampleContext(
    accountId: string,
    automationId: string | undefined,
    contactId?: string,
  ): Promise<{
    context: AutomationContext;
    contactId: string | null;
    note?: string;
  }> {
    const contact = contactId
      ? await this.prisma.contacts.findFirst({
          where: { id: contactId, account_id: accountId },
        })
      : await this.prisma.contacts.findFirst({
          where: { account_id: accountId },
          orderBy: { created_at: 'desc' },
        });

    if (!contact) {
      return {
        context: {},
        contactId: null,
        note: 'No contacts in this workspace yet, so tokens about the contact resolve to nothing.',
      };
    }

    const conversation = await this.prisma.conversations.findFirst({
      where: { account_id: accountId, contact_id: contact.id },
      orderBy: { last_message_at: 'desc' },
      select: { id: true, channel: true },
    });

    const lastInbound = conversation
      ? await this.prisma.messages.findFirst({
          // `sender_type` is how inbound is recorded — there is no
          // `direction` column. A preview should quote what the CUSTOMER
          // last said, since that is what {{ message.text }} holds.
          where: { conversation_id: conversation.id, sender_type: 'contact' },
          orderBy: { created_at: 'desc' },
          select: { content_text: true },
        })
      : null;

    return {
      contactId: contact.id,
      context: {
        contact: {
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          company: contact.company,
        },
        message_text: lastInbound?.content_text ?? '',
        conversation_id: conversation?.id,
        channel:
          (conversation?.channel as AutomationContext['channel']) ?? undefined,
        steps: automationId
          ? await this.lastRunOutputs(accountId, automationId)
          : {},
      },
    };
  }

  /**
   * What each step returned on the most recent run.
   *
   * Keyed by the step's KEY, not its id: saving an automation replaces
   * every row, so yesterday's log cannot be lined up with today's steps
   * by id. Runs are scanned newest-first and the first output seen for a
   * key wins, so a step that only ran in an earlier run still
   * contributes.
   */
  private async lastRunOutputs(
    accountId: string,
    automationId: string,
  ): Promise<Record<string, unknown>> {
    const logs = await this.prisma.automationLog.findMany({
      where: { automationId, accountId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { stepsExecuted: true },
    });

    const out: Record<string, unknown> = {};
    for (const log of logs) {
      const items = Array.isArray(log.stepsExecuted)
        ? (log.stepsExecuted as { step_key?: string; output?: unknown }[])
        : [];
      for (const item of items) {
        if (!item?.step_key || item.output === undefined) continue;
        if (!(item.step_key in out)) out[item.step_key] = item.output;
      }
    }
    return out;
  }

  /**
   * Resolve a step's config against the sample context and describe what
   * would happen, without doing any of it.
   */
  preview(
    stepType: AutomationStepType,
    config: Record<string, unknown>,
    context: AutomationContext,
  ): { summary: string; payload: unknown; unresolved: string[] } {
    const unresolved = findUnresolved(config, context);

    switch (stepType) {
      case 'http_request':
      case 'send_webhook': {
        const cfg = config as unknown as SendWebhookStepConfig;
        const method = (cfg.method ?? 'POST').toUpperCase();
        const url = interpolate(String(cfg.url ?? ''), context);
        const body =
          cfg.body_mode === 'raw'
            ? interpolate(String(cfg.body_template ?? ''), context)
            : interpolateDeep(cfg.body_fields ?? {}, context);
        return {
          // The URL is shown in full here (unlike the log line, which
          // redacts it) — this response goes only to the person editing
          // the automation, who can already read the config.
          summary: `${method} ${url || '(no URL)'}`,
          payload: {
            method,
            url,
            query: interpolateDeep(cfg.query ?? {}, context),
            headers: {
              ...(interpolateDeep(cfg.headers ?? {}, context) as Record<
                string,
                unknown
              >),
              ...(cfg.auth && cfg.auth.type !== 'none'
                ? { authorization: '(set from the Authentication field)' }
                : {}),
            },
            body,
          },
          unresolved,
        };
      }

      /**
       * A connected-app action.
       *
       * The preview shows the RESOLVED INPUT, not a request. There is no
       * useful "what would be sent" here: the request shape is the
       * connector's business and changes with the provider's API, while
       * what the author actually needs to check is whether
       * `{{ contact.email }}` came out as an address.
       *
       * Note this deliberately does not reach the provider. Google has
       * no dry-run, so anything that talked to it would not be a
       * preview — that is what the Test tab's confirmed run is for.
       */
      case 'app_action': {
        const app = String(config.app ?? '');
        const actionId = String(config.action ?? '');
        const connector = this.connectors.find(app);
        const action = connector?.actions.find((a) => a.id === actionId);

        const input = action
          ? interpolateAppActionInput(
              action.inputs,
              config.input as Record<string, unknown> | undefined,
              context,
            )
          : interpolateDeep(config.input ?? {}, context);

        return {
          summary: connector
            ? `${connector.name}: ${action?.label ?? (actionId || '(no action)')}`
            : `(unknown app "${app}")`,
          payload: {
            app: connector?.name ?? app,
            action: action?.label ?? actionId,
            // Flagged rather than hidden: an author testing a send needs
            // to know it will really send before they press the button.
            sends_for_real: action?.irreversible ?? false,
            input,
          },
          unresolved,
        };
      }

      case 'send_message':
      case 'add_note': {
        const text = interpolate(String(config.text ?? ''), context);
        return {
          summary: text || '(empty message)',
          payload: { text },
          unresolved,
        };
      }

      case 'send_media':
        return {
          summary: `${config.kind ?? 'image'} → ${interpolate(String(config.link ?? ''), context)}`,
          payload: {
            kind: config.kind ?? 'image',
            link: interpolate(String(config.link ?? ''), context),
            caption: interpolate(String(config.caption ?? ''), context),
          },
          unresolved,
        };

      case 'send_template': {
        const variables = (config.variables as Record<string, string>) ?? {};
        const resolved: Record<string, string> = {};
        for (const [k, v] of Object.entries(variables)) {
          resolved[k] = interpolate(String(v ?? ''), context);
        }
        return {
          summary: `Template "${config.template_name ?? '(none)'}"`,
          payload: { template: config.template_name, variables: resolved },
          unresolved,
        };
      }

      case 'send_buttons':
        return {
          summary: interpolate(String(config.body_text ?? ''), context),
          payload: {
            body: interpolate(String(config.body_text ?? ''), context),
            buttons: interpolateDeep(config.buttons ?? [], context),
          },
          unresolved,
        };

      case 'set_variable': {
        const value = resolveValue(config.value, context);
        return {
          summary: `vars.${config.name ?? '?'} = ${JSON.stringify(value)}`,
          payload: { name: config.name, value },
          unresolved,
        };
      }

      default:
        // Everything else is a database write with no payload worth
        // rendering. Showing the resolved config is still useful — it is
        // where a mistyped token shows up.
        return {
          summary: `${stepType.replace(/_/g, ' ')} with the settings below`,
          payload: interpolateDeep(config, context),
          unresolved,
        };
    }
  }

  /**
   * Execute one step for real, once.
   *
   * Reaches the executor's private `runStep` deliberately: the point of
   * the Test button is that it does EXACTLY what a run does, and any
   * separate path here would be a second implementation to keep in step.
   */
  async runOnce(
    accountId: string,
    userId: string,
    automationId: string | undefined,
    stepType: string,
    config: Record<string, unknown>,
    context: AutomationContext,
    contactId: string | null,
  ): Promise<{ detail: string; output?: unknown }> {
    if (automationId) {
      const owned = await this.prisma.automation.findFirst({
        where: { id: automationId, accountId },
        select: { id: true },
      });
      if (!owned) throw new NotFoundException({ error: 'Not found' });
    }

    return (
      this.executor as unknown as {
        runStep: (
          s: {
            id: string;
            key?: string | null;
            stepType: string;
            stepConfig: unknown;
            position: number;
          },
          a: {
            automation: { id: string; accountId: string; userId: string };
            contactId: string | null;
            context: AutomationContext;
            parentStepId: null;
            branch: null;
            startPosition: number;
            logId: null;
            triggerEvent: string;
          },
        ) => Promise<{ detail: string; output?: unknown }>;
      }
    ).runStep(
      {
        id: 'preview',
        key: 'preview',
        stepType,
        stepConfig: config,
        position: 0,
      },
      {
        automation: { id: automationId ?? 'preview', accountId, userId },
        contactId,
        context,
        parentStepId: null,
        branch: null,
        startPosition: 0,
        // No log row: a test is not a run of the automation, and mixing
        // the two would make the logs page lie about how often it fired.
        logId: null,
        triggerEvent: 'manual_test',
      },
    );
  }
}

/**
 * Tokens that resolve to nothing against the sample context.
 *
 * The single most useful thing a preview can say, because the engine
 * resolves an unknown token to an empty string and sends the message
 * anyway.
 */
function findUnresolved(config: unknown, context: AutomationContext): string[] {
  const out = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(value))) {
        const path = match[1].split('|')[0].trim();
        const resolved = interpolate(`{{ ${match[1]} }}`, context);
        if (resolved === '') out.add(path);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(config);
  return [...out];
}

export { redactUrl };
