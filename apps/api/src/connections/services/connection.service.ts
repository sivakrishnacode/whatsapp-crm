import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import { GOOGLE_REVOKE_URL } from '../connectors/google/google.oauth';
import type { ConnectionSummary } from '../connections.types';

/**
 * Reads and writes `app_connections`, and is the only thing that decides
 * what a browser is allowed to see about one.
 *
 * ⚠️ EVERY QUERY IS SCOPED BY account_id, BY HAND.
 *   `app_connections` has RLS on with zero policies and rights revoked
 *   (migration 082), so RLS is not protecting anything here — apps/api
 *   connects as the database owner. A `findUnique({ where: { id } })`
 *   would happily return another tenant's connection, and the id often
 *   arrives from an automation's step config. The account filter IS the
 *   tenant boundary.
 *
 * ⚠️ `toSummary` IS THE ONLY SHAPE THAT LEAVES THIS SERVICE.
 *   It has no token fields and must never grow one. Returning the row
 *   directly would put an encrypted refresh token in a JSON response,
 *   where the encryption is the only thing standing between a browser
 *   and somebody's mailbox.
 */
@Injectable()
export class ConnectionService {
  private readonly logger = new Logger(ConnectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(accountId: string): Promise<ConnectionSummary[]> {
    const rows = await this.prisma.app_connections.findMany({
      where: { account_id: accountId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toSummary(row));
  }

  async findForAccount(args: {
    connectionId: string;
    accountId: string;
  }): Promise<ConnectionSummary> {
    const row = await this.prisma.app_connections.findFirst({
      where: { id: args.connectionId, account_id: args.accountId },
    });
    if (!row) {
      throw new NotFoundException('Connection not found in this workspace.');
    }
    return this.toSummary(row);
  }

  /**
   * Disconnect: revoke at Google FIRST, then delete the row.
   *
   * That order is deliberate. If the delete came first and the revoke
   * failed, we would have thrown away the only copy of a credential that
   * still works — the user believes they disconnected, and a token for
   * their mailbox lives on in Google's grant list with no way for us to
   * retract it.
   *
   * A revoke that fails does NOT block the delete, though: the user
   * asked to disconnect, and leaving a row they cannot remove because
   * Google is having an outage is worse. It is logged, and the grant
   * remains revocable by hand at myaccount.google.com.
   */
  async disconnect(args: {
    connectionId: string;
    accountId: string;
  }): Promise<void> {
    const row = await this.prisma.app_connections.findFirst({
      where: { id: args.connectionId, account_id: args.accountId },
    });
    if (!row) {
      throw new NotFoundException('Connection not found in this workspace.');
    }

    await this.revokeAtProvider(
      row.provider,
      row.refreshToken ?? row.accessToken,
    ).catch((err: Error) => {
      this.logger.warn(
        `Could not revoke ${row.provider} connection ${row.id} at the provider: ${err.message}. ` +
          'Deleting locally anyway; the grant can be removed at the provider.',
      );
    });

    await this.prisma.app_connections.delete({ where: { id: row.id } });
  }

  private async revokeAtProvider(
    provider: string,
    encryptedToken: string,
  ): Promise<void> {
    if (provider !== 'google') return;

    const token = decrypt(encryptedToken);
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      redirect: 'manual',
    });
    // Google answers 200 for a successful revoke and 400 for a token it
    // does not recognise. The second is not a failure worth surfacing:
    // an already-revoked grant is the state we were trying to reach.
    if (!res.ok && res.status !== 400) {
      throw new Error(`revoke endpoint returned ${res.status}`);
    }
  }

  private toSummary(row: {
    id: string;
    provider: string;
    displayName: string | null;
    scopes: string[];
    status: string;
    lastError: string | null;
    createdAt: Date;
  }): ConnectionSummary {
    return {
      id: row.id,
      provider: row.provider,
      displayName: row.displayName,
      scopes: row.scopes,
      status: row.status as ConnectionSummary['status'],
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
