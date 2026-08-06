import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt, encrypt } from '../../common/security/encryption.util';
import { assertPublicUrl } from '../lib/http-guard';
import { BUILTIN_TOOLS } from '../lib/tools/builtin';
import {
  parseActionParameters,
  runAction,
  type ActionParameter,
  type AgentAction,
} from '../lib/tools/actions';
import { AiError } from '../lib/types';

const NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_ACTIONS_PER_ACCOUNT = 20;

/** Header names we refuse to let an action set. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'user-agent',
]);

/**
 * ============================================================
 * Custom API actions — CRUD plus a "test it" call.
 *
 * SECURITY SHAPE (the reason this is a service, not four inline handlers)
 *   - `headers` may hold an API key, so the object is encrypted at rest
 *     with the same helper as the provider key and NEVER returned. The
 *     client gets header NAMES only; that is enough to render "which
 *     credentials are set" without handing them back to a browser.
 *   - The URL is validated with `assertPublicUrl` at save time, so an
 *     action pointing at 127.0.0.1 or the cloud metadata endpoint is
 *     rejected while a human is watching, not at 3am inside a reply.
 *     It is validated AGAIN on every call (`safeFetch`), because DNS can
 *     change under a hostname that was public when it was saved.
 *   - An action may not take a built-in tool's name: the skill prompt
 *     tells the model what `lookup_orders` does, and letting an account
 *     rebind that name to an arbitrary endpoint is a confused deputy.
 * ============================================================
 */
@Injectable()
export class AgentActionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(accountId: string) {
    const rows = await this.prisma.ai_agent_actions.findMany({
      where: { account_id: accountId },
      orderBy: [{ intent: 'asc' }, { created_at: 'asc' }],
    });

    return {
      actions: rows.map((row) => ({
        id: row.id,
        name: row.name,
        intent: row.intent,
        description: row.description,
        method: row.method,
        url: row.url,
        parameters: parseActionParameters(row.parameters),
        enabled: row.enabled,
        timeout_ms: row.timeout_ms,
        // Names, never values.
        header_names: this.headerNames(row.headers_enc),
        last_used_at: row.last_used_at,
        last_status: row.last_status,
        last_error: row.last_error,
        updated_at: row.updated_at,
      })),
      limits: { max: MAX_ACTIONS_PER_ACCOUNT },
    };
  }

  private headerNames(encrypted: string | null): string[] {
    if (!encrypted) return [];
    try {
      const parsed = JSON.parse(decrypt(encrypted)) as Record<string, unknown>;
      return Object.keys(parsed ?? {});
    } catch {
      return ['(unreadable — re-enter the headers)'];
    }
  }

  private async validateBody(
    body: Record<string, unknown>,
    { partial }: { partial: boolean },
  ) {
    const out: Record<string, unknown> = {};

    if (body.name !== undefined || !partial) {
      const name = String(body.name ?? '')
        .trim()
        .toLowerCase();
      if (!NAME_RE.test(name)) {
        throw new HttpException(
          {
            error:
              'Name must start with a letter and use only lowercase letters, numbers and underscores (e.g. check_stock).',
            code: 'invalid_action_name',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      if (BUILTIN_TOOLS[name]) {
        throw new HttpException(
          {
            error: `"${name}" is a built-in tool name. Pick a different name.`,
            code: 'reserved_action_name',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      out.name = name;
    }

    if (body.description !== undefined || !partial) {
      const description = String(body.description ?? '').trim();
      if (description.length < 10) {
        throw new HttpException(
          {
            error:
              'Describe what the action does in a sentence — this is what the agent reads to decide when to call it.',
            code: 'invalid_action_description',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      out.description = description.slice(0, 500);
    }

    if (body.method !== undefined || !partial) {
      const method = String(body.method ?? 'GET').toUpperCase();
      if (!METHODS.includes(method)) {
        throw new HttpException(
          { error: `Method must be one of: ${METHODS.join(', ')}`, code: 'invalid_method' },
          HttpStatus.BAD_REQUEST,
        );
      }
      out.method = method;
    }

    if (body.url !== undefined || !partial) {
      const url = String(body.url ?? '').trim();
      // Placeholders are legal in the stored URL but not in a parsed one,
      // so validate a version with them filled by a harmless token.
      const probe = url.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, 'placeholder');
      try {
        await assertPublicUrl(probe);
      } catch (err) {
        throw new HttpException(
          {
            error: err instanceof AiError ? err.message : 'That URL cannot be used.',
            code: err instanceof AiError ? err.code : 'invalid_url',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      out.url = url.slice(0, 2000);
    }

    if (body.intent !== undefined) {
      const intent = String(body.intent ?? '').trim();
      out.intent = intent ? intent.slice(0, 80) : null;
    }

    if (body.parameters !== undefined) {
      const parameters = parseActionParameters(body.parameters);
      const declared = Array.isArray(body.parameters) ? body.parameters.length : 0;
      if (declared > 0 && parameters.length === 0) {
        throw new HttpException(
          {
            error:
              'No usable parameters. A parameter needs a name of letters, digits and underscores.',
            code: 'invalid_parameters',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      out.parameters = parameters as unknown as object;
    }

    if (body.headers !== undefined) {
      if (body.headers === null) {
        out.headers_enc = null;
      } else if (typeof body.headers === 'object' && !Array.isArray(body.headers)) {
        const entries = Object.entries(body.headers as Record<string, unknown>)
          .filter(([key, value]) => typeof value === 'string' && key.trim())
          .map(([key, value]) => [key.trim(), String(value)] as const)
          .filter(([key]) => !RESERVED_HEADERS.has(key.toLowerCase()))
          .slice(0, 10);
        out.headers_enc =
          entries.length > 0 ? encrypt(JSON.stringify(Object.fromEntries(entries))) : null;
      }
    }

    if (body.enabled !== undefined) out.enabled = body.enabled === true;

    if (body.timeout_ms !== undefined) {
      const timeout = Number(body.timeout_ms);
      out.timeout_ms = Number.isFinite(timeout)
        ? Math.min(30_000, Math.max(1000, Math.floor(timeout)))
        : 8000;
    }

    return out;
  }

  async create(args: {
    accountId: string;
    userId: string;
    body: Record<string, unknown>;
  }) {
    const count = await this.prisma.ai_agent_actions.count({
      where: { account_id: args.accountId },
    });
    if (count >= MAX_ACTIONS_PER_ACCOUNT) {
      throw new HttpException(
        {
          error: `You can have up to ${MAX_ACTIONS_PER_ACCOUNT} actions. A model handed more than that picks badly.`,
          code: 'too_many_actions',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const data = await this.validateBody(args.body, { partial: false });

    const duplicate = await this.prisma.ai_agent_actions.findFirst({
      where: { account_id: args.accountId, name: data.name as string },
      select: { id: true },
    });
    if (duplicate) {
      throw new HttpException(
        { error: `An action called "${data.name}" already exists.`, code: 'duplicate_action' },
        HttpStatus.CONFLICT,
      );
    }

    const created = await this.prisma.ai_agent_actions.create({
      data: {
        account_id: args.accountId,
        created_by: args.userId,
        name: data.name as string,
        description: data.description as string,
        method: (data.method as string) ?? 'GET',
        url: data.url as string,
        intent: (data.intent as string | null) ?? null,
        parameters: (data.parameters as object) ?? [],
        headers_enc: (data.headers_enc as string | null) ?? null,
        enabled: data.enabled === undefined ? true : (data.enabled as boolean),
        timeout_ms: (data.timeout_ms as number) ?? 8000,
      },
      select: { id: true },
    });

    return { success: true, id: created.id };
  }

  async update(args: {
    accountId: string;
    actionId: string;
    body: Record<string, unknown>;
  }) {
    const existing = await this.prisma.ai_agent_actions.findFirst({
      where: { id: args.actionId, account_id: args.accountId },
      select: { id: true, name: true },
    });
    if (!existing) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    const data = await this.validateBody(args.body, { partial: true });
    if (Object.keys(data).length === 0) {
      throw new HttpException('Nothing to update', HttpStatus.BAD_REQUEST);
    }

    if (data.name && data.name !== existing.name) {
      const duplicate = await this.prisma.ai_agent_actions.findFirst({
        where: { account_id: args.accountId, name: data.name as string },
        select: { id: true },
      });
      if (duplicate) {
        throw new HttpException(
          { error: `An action called "${data.name}" already exists.`, code: 'duplicate_action' },
          HttpStatus.CONFLICT,
        );
      }
    }

    await this.prisma.ai_agent_actions.update({
      where: { id: existing.id },
      // Clearing the last error on any edit: it described the previous
      // configuration, and leaving it makes a fixed action look broken.
      data: { ...data, last_error: null },
    });

    return { success: true };
  }

  async remove(accountId: string, actionId: string) {
    const existing = await this.prisma.ai_agent_actions.findFirst({
      where: { id: actionId, account_id: accountId },
      select: { id: true },
    });
    if (!existing) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    await this.prisma.ai_agent_actions.delete({ where: { id: existing.id } });
    return { success: true };
  }

  /**
   * Call the action once with values the ADMIN supplies, and show them
   * exactly what came back. This is the only place an action's response
   * body is shown to a human, and it is why an action can be trusted
   * before a customer depends on it.
   */
  async test(args: {
    accountId: string;
    actionId: string;
    arguments?: Record<string, unknown>;
  }) {
    const row = await this.prisma.ai_agent_actions.findFirst({
      where: { id: args.actionId, account_id: args.accountId },
    });
    if (!row) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

    let headers: Record<string, string> = {};
    if (row.headers_enc) {
      try {
        headers = JSON.parse(decrypt(row.headers_enc)) as Record<string, string>;
      } catch {
        throw new HttpException(
          {
            error:
              'The saved headers could not be decrypted (check ENCRYPTION_KEY). Re-enter them and try again.',
            code: 'headers_decrypt_failed',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const action: AgentAction = {
      id: row.id,
      name: row.name,
      description: row.description,
      method: row.method,
      url: row.url,
      headers,
      parameters: parseActionParameters(row.parameters) as ActionParameter[],
      timeoutMs: row.timeout_ms,
    };

    const startedAt = Date.now();
    const result = await runAction(action, args.arguments ?? {});
    const durationMs = Date.now() - startedAt;

    await this.prisma.ai_agent_actions.update({
      where: { id: row.id },
      data: {
        last_used_at: new Date(),
        last_status: result.status,
        last_error: result.ok ? null : result.detail.slice(0, 1000),
      },
    });

    return {
      ok: result.ok,
      status: result.status,
      duration_ms: durationMs,
      // The same string the model would see, so a confusing reply can be
      // traced back to a confusing tool result.
      result: result.detail,
    };
  }
}
