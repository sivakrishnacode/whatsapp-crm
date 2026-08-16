import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiError } from '../lib/types';
import {
  LOW_BALANCE_THRESHOLD,
  creditsForEmbedding,
  creditsForGeneration,
  signupGrantCredits,
} from './credits.constants';

/**
 * Which part of the product spent a credit.
 *
 * ⚠️ PINNED BY A CHECK CONSTRAINT on `ai_credit_ledger.feature`. A value
 * added here without the matching migration fails the INSERT inside
 * `consume_ai_credits`, which is caught and logged — so the spend
 * silently stops being metered rather than erroring. Migration 083 added
 * 'automation_draft'; 088 added 'flow_draft'.
 */
export type CreditFeature =
  | 'draft'
  | 'auto_reply'
  | 'playground'
  | 'embedding'
  /** The AI automation builder. No conversation attached, unlike 'draft'. */
  | 'automation_draft'
  /** The AI flow builder. Its own value so the two surfaces stay
   *  separable in the ledger — see migration 088. */
  | 'flow_draft';

/** A thrown value is not necessarily an Error; log it without pretending. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface WalletSummary {
  balance: number;
  lifetimePurchased: number;
  lifetimeConsumed: number;
  low: boolean;
  threshold: number;
}

export interface ChargeArgs {
  accountId: string;
  feature: CreditFeature;
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  conversationId?: string | null;
  userId?: string | null;
}

/**
 * ============================================================
 * The AI credit wallet.
 *
 * Every balance movement goes through `grant_ai_credits` /
 * `consume_ai_credits` (migration 072) rather than a Prisma update.
 * Not for elegance — for correctness:
 *
 *   - Two inbound messages on the same workspace are answered
 *     concurrently by the ai-reply queue. A read-then-write in
 *     JavaScript lets both read the same balance and each subtract from
 *     it, and the wallet drifts by exactly the amount you were trying
 *     to meter.
 *   - The ledger row is written in the same statement as the balance
 *     move, so a balance that changed without an audit trail is not a
 *     state this table can reach.
 *
 * ⚠️ Prisma connects as the database owner, so RLS is not scoping any
 * of this. Every method here takes an accountId and every query filters
 * on it — that filter IS the tenant boundary.
 * ============================================================
 */
@Injectable()
export class AiCreditsService {
  private readonly logger = new Logger(AiCreditsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the wallet, creating it with the welcome grant on first touch.
   *
   * Lazy rather than a hook on account creation: signup already spans
   * several tables and a failure there must not cost someone their
   * workspace. The grant is latched by `signup_granted_at` inside a
   * conditional insert, so two concurrent first-touches cannot both
   * grant.
   */
  async getWallet(accountId: string): Promise<WalletSummary> {
    const rows = await this.prisma.$queryRaw<
      {
        balance: number;
        lifetime_purchased: number;
        lifetime_consumed: number;
      }[]
    >`
      SELECT balance, lifetime_purchased, lifetime_consumed
        FROM ai_credit_wallets
       WHERE account_id = ${accountId}::uuid
    `;

    if (rows.length === 0) {
      await this.grantSignupCredits(accountId);
      return this.readWalletOrEmpty(accountId);
    }

    const row = rows[0];
    return {
      balance: row.balance,
      lifetimePurchased: row.lifetime_purchased,
      lifetimeConsumed: row.lifetime_consumed,
      low: row.balance <= LOW_BALANCE_THRESHOLD,
      threshold: LOW_BALANCE_THRESHOLD,
    };
  }

  private async readWalletOrEmpty(accountId: string): Promise<WalletSummary> {
    const rows = await this.prisma.$queryRaw<
      {
        balance: number;
        lifetime_purchased: number;
        lifetime_consumed: number;
      }[]
    >`
      SELECT balance, lifetime_purchased, lifetime_consumed
        FROM ai_credit_wallets
       WHERE account_id = ${accountId}::uuid
    `;
    const row = rows[0];
    return {
      balance: row?.balance ?? 0,
      lifetimePurchased: row?.lifetime_purchased ?? 0,
      lifetimeConsumed: row?.lifetime_consumed ?? 0,
      low: (row?.balance ?? 0) <= LOW_BALANCE_THRESHOLD,
      threshold: LOW_BALANCE_THRESHOLD,
    };
  }

  /** One-time welcome grant. Safe to call repeatedly. */
  async grantSignupCredits(accountId: string): Promise<void> {
    const amount = signupGrantCredits();
    if (amount <= 0) return;

    try {
      // The wallet row is inserted first with the latch already set, so
      // a second caller conflicts and grants nothing. The grant itself
      // then only runs for the caller that won the insert.
      const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO ai_credit_wallets (account_id, balance, signup_granted_at)
        VALUES (${accountId}::uuid, 0, now())
        ON CONFLICT (account_id) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) return;

      await this.prisma.$queryRaw`
        SELECT grant_ai_credits(
          ${accountId}::uuid, ${amount}::integer, 'signup_grant',
          NULL, NULL, 'Welcome credits'
        )
      `;
    } catch (err) {
      // A missing wallet degrades to "no credits", which the caller
      // reports as needing a top-up. Failing the whole request because
      // a bonus could not be granted would be worse.
      this.logger.error(
        `[ai credits] signup grant failed for account ${accountId}: ${errorText(err)}`,
      );
    }
  }

  /**
   * Is there enough left to start a call?
   *
   * One credit, not the call's eventual cost — which is unknowable
   * until the provider has answered. See `consume_ai_credits`: the
   * shortfall on the last call of a wallet is absorbed by us rather
   * than left as a debt on the customer.
   */
  async hasBalance(accountId: string): Promise<boolean> {
    const wallet = await this.getWallet(accountId);
    return wallet.balance >= 1;
  }

  /** The error the three entry points raise when the wallet is empty. */
  outOfCreditsError(): AiError {
    return new AiError(
      'You have run out of AI credits. Top up from Settings → AI credits, or switch the agent to your own provider key.',
      { code: 'ai_credits_exhausted', status: 402 },
    );
  }

  /**
   * Charge for a completed generation. Never throws: the reply has
   * already been produced and, on the auto-reply path, already sent.
   * Failing here must not turn a delivered answer into an error — the
   * correct handling of a metering failure is a log line and a
   * reconciliation, not a customer who does not get their reply.
   */
  async chargeGeneration(args: ChargeArgs): Promise<number> {
    const credits = creditsForGeneration(args.usage);
    return this.charge({ ...args, credits });
  }

  /** Charge for indexing knowledge. Same never-throws contract. */
  async chargeEmbedding(args: {
    accountId: string;
    provider: string;
    model: string;
    tokens: number;
    userId?: string | null;
  }): Promise<number> {
    return this.charge({
      accountId: args.accountId,
      feature: 'embedding',
      provider: args.provider,
      model: args.model,
      usage: { inputTokens: args.tokens, outputTokens: 0 },
      userId: args.userId,
      credits: creditsForEmbedding(args.tokens),
    });
  }

  private async charge(
    args: ChargeArgs & { credits: number },
  ): Promise<number> {
    try {
      const rows = await this.prisma.$queryRaw<
        { consume_ai_credits: number }[]
      >`
        SELECT consume_ai_credits(
          ${args.accountId}::uuid,
          ${args.credits}::integer,
          ${args.feature}::text,
          ${args.provider}::text,
          ${args.model}::text,
          ${args.usage.inputTokens}::integer,
          ${args.usage.outputTokens}::integer,
          ${args.conversationId ?? null}::uuid,
          ${args.userId ?? null}::uuid
        ) AS consume_ai_credits
      `;
      return rows[0]?.consume_ai_credits ?? 0;
    } catch (err) {
      this.logger.error(
        `[ai credits] could not charge ${args.credits} credit(s) to account ${args.accountId} for ${args.feature}: ${errorText(err)}`,
      );
      return 0;
    }
  }

  /**
   * Move a paid top-up's credits into the wallet, exactly once.
   *
   * `credited_at` is set inside the same transaction that grants, and
   * the claiming UPDATE requires it to still be null — so the browser
   * callback and Razorpay's webhook racing each other produce one grant
   * and one no-op, whichever order they arrive in. Both paths call this;
   * neither may inline its own version.
   */
  async creditOrder(orderId: string, paymentId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<
        { account_id: string; credits: number }[]
      >`
        UPDATE ai_credit_orders
           SET status = 'paid',
               gateway_payment_id = ${paymentId},
               credited_at = now(),
               updated_at = now()
         WHERE id = ${orderId}::uuid
           AND credited_at IS NULL
        RETURNING account_id, credits
      `;

      if (claimed.length === 0) {
        // Already credited. Report the current balance anyway, so a
        // duplicate callback still shows the user the right number.
        const wallet = await tx.$queryRaw<{ balance: number }[]>`
          SELECT w.balance
            FROM ai_credit_wallets w
            JOIN ai_credit_orders o ON o.account_id = w.account_id
           WHERE o.id = ${orderId}::uuid
        `;
        return wallet[0]?.balance ?? 0;
      }

      const { account_id, credits } = claimed[0];
      const granted = await tx.$queryRaw<{ grant_ai_credits: number }[]>`
        SELECT grant_ai_credits(
          ${account_id}::uuid, ${credits}::integer, 'purchase',
          ${orderId}::uuid, NULL, NULL
        ) AS grant_ai_credits
      `;
      return granted[0]?.grant_ai_credits ?? 0;
    });
  }

  /**
   * The webhook's entry point: it knows Razorpay's order id, not ours.
   * Returns false when there is no such top-up, which is the normal
   * case — the same webhook carries plan payments too.
   */
  async creditByGatewayOrderId(
    gatewayOrderId: string,
    paymentId: string,
  ): Promise<boolean> {
    const order = await this.prisma.ai_credit_orders.findUnique({
      where: { gateway_order_id: gatewayOrderId },
      select: { id: true },
    });
    if (!order) return false;
    await this.creditOrder(order.id, paymentId);
    return true;
  }

  /** Spend history for the billing screen. Admin-gated by the controller. */
  async listLedger(accountId: string, limit = 50) {
    return this.prisma.ai_credit_ledger.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
      select: {
        id: true,
        delta: true,
        balance_after: true,
        reason: true,
        feature: true,
        model: true,
        input_tokens: true,
        output_tokens: true,
        note: true,
        created_at: true,
      },
    });
  }
}
