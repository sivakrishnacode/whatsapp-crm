import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * The panel's audit trail (migration 073).
 *
 * ## Why this exists now
 *
 * `user_subscriptions.manually_assigned_by` is a FK to `auth.users` and this
 * panel's administrator is an env credential, not a row in that table — so
 * until now a change made here was simply not attributable in the database.
 * That was survivable while the panel only edited billing rows whose effect the
 * customer could see. It stops being survivable the moment it can create AI
 * credits out of nothing.
 *
 * ## Two records, on purpose
 *
 * A credit adjustment writes twice: `ai_credit_ledger` gets the movement with
 * the actor folded into its `note` (inside the same statement that moves the
 * balance — see `admin_adjust_ai_credits`), and this table gets the operational
 * record. The ledger copy is the one that cannot be lost, which is exactly why
 * `recordAudit` is allowed to fail soft: a write that has already happened must
 * not be reported as failed because its bookkeeping row did not land.
 *
 * Everything else in the panel has no such second record, so for those a
 * missing audit row is a real gap — hence the loud log line rather than a
 * silent catch.
 */

export type AuditTargetType =
  | 'workspace'
  | 'member'
  | 'invitation'
  | 'subscription'
  | 'plan'
  | 'credit_pack'
  | 'credit_wallet';

export type AuditEntry = {
  /** The signed-in ADMIN_USERNAME. */
  actor: string;
  /** Stable dotted verb, e.g. 'credits.adjust'. Grouped on in the UI. */
  action: string;
  targetType: AuditTargetType;
  targetId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  /** One sentence, in the past tense, as it should read a year from now. */
  summary: string;
  detail?: Record<string, unknown>;
};

/**
 * Call this AFTER the write it describes has succeeded. An audit row for
 * something that then failed is worse than no row: it sends the next person
 * looking for a change that was never made.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.admin_audit_log.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        target_type: entry.targetType,
        target_id: entry.targetId ?? null,
        account_id: entry.accountId ?? null,
        user_id: entry.userId ?? null,
        summary: entry.summary,
        detail: (entry.detail ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    console.error(
      `[admin-panel] AUDIT WRITE FAILED — ${entry.actor} ${entry.action}: ${entry.summary}`,
      error
    );
  }
}
