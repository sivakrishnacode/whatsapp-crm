import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { decrypt, encrypt } from '../../common/security/encryption.util';
import { BRIDGE_VERSION } from '../google-script.catalog';
import type { GoogleScriptConnectionSummary } from '../google-script.types';

/**
 * The workspace's Apps Script bridge: stored, validated, and decrypted in
 * exactly one place.
 *
 * ⚠️ THIS IS THE ONLY PLACE THE SECRET IS DECRYPTED, and it is the same
 * rule the OAuth connector's token service carried, for a credential that
 * is arguably worse: `execUrl` + secret sends mail as the customer, and
 * unlike an OAuth token it cannot be revoked from our side — only by them
 * redeploying. So it must never appear in a queue payload (Redis stores
 * job data in plaintext and Bull Board renders it), an API response, or a
 * log line.
 *
 * ⚠️ WE GENERATE THE SECRET; THE CUSTOMER NEVER INVENTS ONE.
 *   Asking somebody to run `openssl rand -hex 32` and paste the result
 *   into two places is how you get `secret123` in production. We mint 32
 *   random bytes, pre-fill them into the script we hand them, and never
 *   need the value back — so the only copy outside the database is inside
 *   their own script project.
 */
@Injectable()
export class GoogleScriptConnectionService {
  private readonly logger = new Logger(GoogleScriptConnectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Where a deployment URL is allowed to point.
   *
   * ⚠️ A HOST ALLOWLIST, NOT A GENERIC SSRF CHECK, AND THAT IS THE
   *    STRONGER CONTROL HERE.
   *
   *   `execUrl` is free text pasted by an admin, and our server then POSTs
   *   to it carrying a secret. A general "is this publicly routable?" test
   *   (which is what `isDeliverableUrl` gives the http_request step) would
   *   happily accept an attacker's collector. Only Apps Script can serve
   *   this bridge, so only Apps Script is accepted, and the redirect it
   *   answers with is pinned just as tightly below.
   */
  private static readonly EXEC_HOST = 'script.google.com';
  /** Where /exec 302s to in order to serve its response body. */
  static readonly RESPONSE_HOST = 'script.googleusercontent.com';

  /**
   * Validate and normalise a pasted deployment URL.
   *
   * Rejects the `/dev` URL explicitly: it looks interchangeable with
   * `/exec` in the Apps Script UI, requires a signed-in Google session,
   * and would fail every automation with an HTML login page — a confusing
   * failure worth naming at paste time.
   */
  static normaliseExecUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(String(raw).trim());
    } catch {
      throw new BadRequestException('That is not a URL. Paste the Web app URL from Apps Script.');
    }
    if (url.protocol !== 'https:') {
      throw new BadRequestException('The deployment URL must be https.');
    }
    if (url.hostname !== GoogleScriptConnectionService.EXEC_HOST) {
      throw new BadRequestException(
        `The deployment URL must be on ${GoogleScriptConnectionService.EXEC_HOST}. ` +
          'Copy the Web app URL from Deploy → Manage deployments.',
      );
    }
    if (url.pathname.endsWith('/dev')) {
      throw new BadRequestException(
        'That is the /dev URL, which only works for a signed-in browser. ' +
          'Use the /exec URL from the deployment dialog.',
      );
    }
    if (!url.pathname.endsWith('/exec')) {
      throw new BadRequestException('The deployment URL should end in /exec.');
    }
    // Drop any query or fragment: the script takes everything in the body,
    // and a stray ?foo would ride along on every call.
    return `${url.origin}${url.pathname}`;
  }

  /** Fresh 32-byte secret, hex. Long enough that the URL is the weak half. */
  static generateSecret(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Create or replace the workspace's bridge, returning the secret ONCE.
   *
   * Replacing rather than editing is deliberate: a new deployment gets a
   * new URL and a customer who redeploys should get a fresh secret rather
   * than carry an old one forward into a script they are re-pasting
   * anyway.
   */
  async provision(
    accountId: string,
    userId: string | null,
  ): Promise<{ secret: string; execUrlPending: true }> {
    const secret = GoogleScriptConnectionService.generateSecret();
    // The URL arrives later — they cannot deploy until they have pasted
    // the secret into the script. An empty exec_url is the "half set up"
    // state, and `connected` stays false until it is filled.
    await this.prisma.google_script_connections.upsert({
      where: { account_id: accountId },
      create: {
        account_id: accountId,
        execUrl: '',
        secretEncrypted: encrypt(secret),
        createdBy: userId,
      },
      update: {
        execUrl: '',
        secretEncrypted: encrypt(secret),
        lastOkAt: null,
        lastError: null,
        lastErrorAt: null,
        updatedAt: new Date(),
      },
    });
    return { secret, execUrlPending: true };
  }

  /** Store the deployment URL once the customer has deployed the script. */
  async saveExecUrl(accountId: string, rawUrl: string): Promise<void> {
    const execUrl = GoogleScriptConnectionService.normaliseExecUrl(rawUrl);
    const existing = await this.prisma.google_script_connections.findUnique({
      where: { account_id: accountId },
    });
    if (!existing) {
      throw new BadRequestException(
        'Generate the script first — the secret has to exist before the URL means anything.',
      );
    }
    await this.prisma.google_script_connections.update({
      where: { account_id: accountId },
      data: { execUrl, lastError: null, lastErrorAt: null, updatedAt: new Date() },
    });
  }

  /**
   * The URL and secret, for the executor only.
   *
   * Returns null when the bridge is absent or half-configured, so callers
   * treat "not set up" and "set up but no URL yet" the same way.
   */
  async resolveCredentials(
    accountId: string,
  ): Promise<{ execUrl: string; secret: string } | null> {
    const row = await this.prisma.google_script_connections.findUnique({
      where: { account_id: accountId },
    });
    if (!row || !row.execUrl) return null;
    try {
      return { execUrl: row.execUrl, secret: decrypt(row.secretEncrypted) };
    } catch (err) {
      // A decryption failure means the encryption key rotated without the
      // rows being re-encrypted. Say so plainly rather than letting every
      // automation fail as "unauthorized" against the customer's script.
      this.logger.error(
        `Could not decrypt the Google script secret for account ${accountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Redacted projection for the browser. Never the secret, never the URL. */
  async summary(accountId: string): Promise<GoogleScriptConnectionSummary> {
    const row = await this.prisma.google_script_connections.findUnique({
      where: { account_id: accountId },
    });
    if (!row) {
      return {
        connected: false,
        execUrlHint: null,
        lastOkAt: null,
        lastError: null,
        lastErrorAt: null,
        createdAt: null,
        scriptVersion: null,
        currentVersion: BRIDGE_VERSION,
        updateAvailable: false,
      };
    }
    return {
      connected: Boolean(row.execUrl),
      execUrlHint: row.execUrl ? GoogleScriptConnectionService.hintFor(row.execUrl) : null,
      lastOkAt: row.lastOkAt?.toISOString() ?? null,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      scriptVersion: row.scriptVersion,
      currentVersion: BRIDGE_VERSION,
      updateAvailable:
        row.scriptVersion !== null && row.scriptVersion < BRIDGE_VERSION,
    };
  }

  /**
   * Last 6 characters of the deployment id.
   *
   * Enough for a human to tell two deployments apart, useless to anybody
   * else — the point is that an Integrations screenshot leaks neither half
   * of the credential.
   */
  private static hintFor(execUrl: string): string {
    const id = execUrl.split('/').filter(Boolean).slice(-2, -1)[0] ?? '';
    return id.length > 6 ? `…${id.slice(-6)}` : id;
  }

  /**
   * `version` is what the script reported. Undefined leaves the stored
   * value alone rather than clearing it — a reply without a version means
   * an older script, not that the last known version stopped being true.
   */
  async recordSuccess(accountId: string, version?: number): Promise<void> {
    await this.prisma.google_script_connections
      .update({
        where: { account_id: accountId },
        data: {
          lastOkAt: new Date(),
          lastError: null,
          lastErrorAt: null,
          ...(typeof version === 'number' ? { scriptVersion: version } : {}),
        },
      })
      // Health bookkeeping must never fail the call it describes.
      .catch(() => undefined);
  }

  async recordFailure(accountId: string, message: string): Promise<void> {
    await this.prisma.google_script_connections
      .update({
        where: { account_id: accountId },
        // Truncated: a Google HTML error page is tens of kilobytes and the
        // column is read by a UI line, not a debugger.
        data: { lastError: message.slice(0, 500), lastErrorAt: new Date() },
      })
      .catch(() => undefined);
  }

  async remove(accountId: string): Promise<void> {
    await this.prisma.google_script_connections
      .delete({ where: { account_id: accountId } })
      .catch(() => undefined);
  }
}
