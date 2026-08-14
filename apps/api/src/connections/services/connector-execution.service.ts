import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectorRegistryService } from './connector-registry.service';
import {
  ConnectionReauthRequired,
  ConnectionTokenService,
} from './connection-token.service';
import { GoogleApiError } from '../utils/google-api.util';
import type {
  ActionResult,
  FieldSpec,
  ResourceOption,
} from '../connections.types';

/**
 * Runs one connector action, and is the only caller of `execute`.
 *
 * THE ORDER OF CHECKS IS THE SECURITY MODEL
 *   1. The connection must belong to the calling account. The id comes
 *      from an automation's step config — author-supplied data — and
 *      Prisma bypasses RLS, so this is the tenant boundary. Done first
 *      because nothing else is safe before it.
 *   2. The action must exist in the registry. An automation saved before
 *      an action was renamed must fail loudly, not silently do nothing.
 *   3. The connection must have granted the action's scopes. Checked
 *      HERE rather than letting Google 403: "Reconnect and tick
 *      Calendar" is actionable, "403 insufficient authentication scopes"
 *      is not.
 *   4. Input must satisfy the action's FieldSpec.
 *   5. Only then is a token decrypted and a request made.
 */
@Injectable()
export class ConnectorExecutionService {
  private readonly logger = new Logger(ConnectorExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistryService,
    private readonly tokens: ConnectionTokenService,
  ) {}

  async run(args: {
    accountId: string;
    connectionId: string;
    app: string;
    actionId: string;
    /** Already interpolated by the caller — this service does no templating. */
    input: Record<string, unknown>;
  }): Promise<ActionResult> {
    const action = this.registry.requireAction(args.app, args.actionId);

    await this.assertScopes({
      accountId: args.accountId,
      connectionId: args.connectionId,
      required: action.scopes,
      appName: this.registry.require(args.app).name,
    });

    const input = validateInput(action.inputs, args.input);

    const accessToken = await this.tokens.getAccessToken({
      connectionId: args.connectionId,
      accountId: args.accountId,
    });

    try {
      return await action.execute({
        input,
        accessToken,
        accountId: args.accountId,
      });
    } catch (err) {
      throw this.translate(err, args.connectionId);
    }
  }

  /** Options for a `resource_select` field — the editor's dropdowns. */
  async resource(args: {
    accountId: string;
    connectionId: string;
    app: string;
    resource: string;
    input: Record<string, unknown>;
  }): Promise<ResourceOption[]> {
    const connector = this.registry.require(args.app);
    const loader = connector.resources?.[args.resource];
    if (!loader) {
      throw new BadRequestException(
        `${connector.name} has no "${args.resource}" list.`,
      );
    }

    // A resource loader reads from the provider, so it needs the app's
    // scopes just as an action does — the union, since a loader can
    // serve fields belonging to several actions.
    await this.assertScopes({
      accountId: args.accountId,
      connectionId: args.connectionId,
      required: this.registry.scopesForApp(args.app),
      appName: connector.name,
    });

    const accessToken = await this.tokens.getAccessToken({
      connectionId: args.connectionId,
      accountId: args.accountId,
    });

    try {
      return await loader({ accessToken, input: args.input });
    } catch (err) {
      throw this.translate(err, args.connectionId);
    }
  }

  /**
   * ⚠️ Also the account-scoping check. Reads the row filtered by
   * account_id; a connection belonging to another tenant is "not found",
   * which is the same answer as one that does not exist — deliberately,
   * so the response cannot be used to probe for other workspaces' ids.
   */
  private async assertScopes(args: {
    accountId: string;
    connectionId: string;
    required: string[];
    appName: string;
  }): Promise<void> {
    const row = await this.prisma.app_connections.findFirst({
      where: { id: args.connectionId, account_id: args.accountId },
      select: { scopes: true, status: true, displayName: true },
    });

    if (!row) {
      throw new BadRequestException(
        'That connection no longer exists in this workspace.',
      );
    }
    if (row.status !== 'active') {
      throw new BadRequestException(
        `The connection for ${row.displayName ?? args.appName} needs to be reconnected.`,
      );
    }

    const missing = args.required.filter((s) => !row.scopes.includes(s));
    if (missing.length > 0) {
      throw new BadRequestException(
        `This connection has not granted access to ${args.appName}. ` +
          `Reconnect it and approve ${args.appName} to continue.`,
      );
    }
  }

  /**
   * Provider errors → messages an automation author can act on.
   *
   * A 401 here means the token died between refresh and use, which is
   * rare but real (a revoke landing mid-request). It is reported as a
   * re-auth rather than a generic failure so the connection surfaces as
   * broken instead of the automation looking flaky.
   */
  private translate(err: unknown, connectionId: string): Error {
    if (err instanceof ConnectionReauthRequired) {
      return new BadRequestException(err.message);
    }
    if (err instanceof GoogleApiError) {
      if (err.status === 401) {
        return new BadRequestException(
          'Google rejected the stored credentials. Reconnect this app from Integrations.',
        );
      }
      if (err.status === 403) {
        return new BadRequestException(
          `Google refused the request: ${err.message}. This usually means a missing permission — reconnect the app.`,
        );
      }
      if (err.status === 429) {
        return new BadRequestException(
          'Google is rate limiting this workspace. Try again shortly.',
        );
      }
      return new BadRequestException(err.message);
    }
    this.logger.error(
      `Unexpected connector failure on connection ${connectionId}`,
      err as Error,
    );
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Validate and coerce a step's input against the action's field specs.
 *
 * WHY COERCION AND NOT STRICT TYPES
 *   Every value may have arrived from `{{ }}` interpolation, which
 *   produces strings. A `number` field fed `{{ steps.lookup.body.total }}`
 *   is legitimately the string "42" at this point, and rejecting it
 *   would make tokens unusable in exactly the fields that most want
 *   them.
 *
 * WHY UNKNOWN KEYS ARE DROPPED RATHER THAN REJECTED
 *   An action that loses a field in a later release would otherwise
 *   break every automation still carrying it. Dropping is the
 *   forward-compatible choice; the field simply stops having an effect.
 */
export function validateInput(
  specs: FieldSpec[],
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const spec of specs) {
    const value = raw[spec.key];

    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0);

    if (empty) {
      if (spec.required) {
        throw new BadRequestException(`"${spec.label}" is required.`);
      }
      if (spec.default !== undefined) out[spec.key] = spec.default;
      continue;
    }

    out[spec.key] = coerce(spec, value);
  }

  return out;
}

function coerce(spec: FieldSpec, value: unknown): unknown {
  switch (spec.kind) {
    case 'number': {
      const n =
        typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) {
        throw new BadRequestException(
          `"${spec.label}" must be a number (got "${String(value)}").`,
        );
      }
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      return s === 'true' || s === 'yes' || s === '1';
    }
    case 'email_list': {
      const list = Array.isArray(value)
        ? value.map(String)
        : String(value).split(/[,;\n]/);
      const emails = list.map((e) => e.trim()).filter(Boolean);
      if (emails.length === 0) {
        throw new BadRequestException(`"${spec.label}" has no addresses.`);
      }
      // Deliberately loose: a full RFC 5322 check rejects addresses that
      // work, and the provider is the real authority. This catches the
      // common failure — an unresolved token leaving a bare word behind.
      const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (bad.length > 0) {
        throw new BadRequestException(
          `"${spec.label}" contains an invalid address: ${bad[0]}`,
        );
      }
      return emails;
    }
    case 'key_values': {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
      }
      throw new BadRequestException(
        `"${spec.label}" must be a set of key/value pairs.`,
      );
    }
    case 'select': {
      const s = String(value);
      if (spec.options && !spec.options.some((o) => o.value === s)) {
        throw new BadRequestException(
          `"${spec.label}" must be one of: ${spec.options.map((o) => o.value).join(', ')}.`,
        );
      }
      return s;
    }
    default:
      return typeof value === 'string' ? value : String(value);
  }
}
