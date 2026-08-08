'use server';

import { Prisma } from '@prisma/client';
import { refresh } from 'next/cache';

import { recordAudit } from '@/lib/actions/audit';
import {
  FieldError,
  boolean,
  decimal,
  integer,
  oneOf,
  optionalText,
  text,
  uuid,
} from '@/lib/actions/parse';
import type { ActionState } from '@/lib/actions/subscriptions';
import { requireAdmin } from '@/lib/auth';
import { maxCreditAdjustment } from '@/lib/env';
import { prisma } from '@/lib/prisma';

/**
 * AI credit writes.
 *
 * ## The balance is never touched directly
 *
 * Every movement goes through `admin_adjust_ai_credits` (migration 073), the
 * third and last supported writer of `ai_credit_wallets.balance`. Not for
 * tidiness: two auto-replies on the same workspace are metered concurrently, so
 * a read-then-write here would let a top-up and a charge each overwrite the
 * other, and the ledger row has to be written in the same statement as the move
 * or a balance can change with nothing to explain it. A Prisma
 * `wallet.update({ balance: … })` in this file would be a bug however carefully
 * it were written.
 *
 * ## Credits are not money
 *
 * A grant here costs us inference on our own Gemini key and earns nothing, so it
 * deliberately does NOT touch `lifetime_purchased` — the function leaves it
 * alone, which keeps top-up revenue on the credits page equal to what customers
 * actually paid. `ADMIN_MAX_CREDIT_ADJUSTMENT` is the server-side ceiling,
 * independent of anything the form allows.
 */

const DIRECTIONS = ['add', 'remove'] as const;

export async function adjustCredits(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await requireAdmin();

  try {
    const accountId = uuid(formData, 'accountId', 'Workspace');
    const direction = oneOf(formData, 'direction', DIRECTIONS, {
      label: 'Direction',
    })!;
    const ceiling = maxCreditAdjustment();
    const amount = integer(formData, 'amount', {
      label: 'Credits',
      min: 1,
      max: ceiling,
    })!;
    // Required, not optional. This is the one action in the panel that creates
    // value out of nothing; an unexplained grant is indistinguishable from an
    // accident when someone reads the ledger back in six months.
    const note = text(formData, 'note', 'Reason');

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        name: true,
        ai_configs: { select: { credit_mode: true } },
      },
    });
    if (!account) throw new FieldError('That workspace no longer exists.');

    const delta = direction === 'add' ? amount : -amount;

    const [result] = await prisma.$queryRaw<
      { new_balance: number; applied: number }[]
    >(Prisma.sql`
      select new_balance, applied
        from admin_adjust_ai_credits(
          ${accountId}::uuid,
          ${delta}::integer,
          ${session.username},
          ${note}
        )
    `);

    const applied = result?.applied ?? 0;
    const balance = result?.new_balance ?? 0;

    if (applied === 0) {
      return {
        error:
          'Nothing to deduct — this workspace has no credits left. ' +
          'The wallet is already at zero.',
      };
    }

    await recordAudit({
      actor: session.username,
      action: direction === 'add' ? 'credits.grant' : 'credits.revoke',
      targetType: 'credit_wallet',
      accountId,
      summary:
        `${direction === 'add' ? 'Granted' : 'Revoked'} ${Math.abs(applied)} ` +
        `AI credit(s) for ${account.name} — ${note}`,
      detail: { requested: amount, applied, balanceAfter: balance },
    });

    refresh();

    // A deduction can only take what is there: `balance >= 0` is a CHECK
    // constraint and a negative wallet would mean a customer owing us before
    // the agent answers anybody. Say so rather than implying the full amount
    // moved.
    const short =
      Math.abs(applied) < amount
        ? ` Only ${Math.abs(applied)} of the ${amount} requested were available.`
        : '';

    // On `byok` the wallet is inert — their provider bills them directly and
    // nothing is metered against credits. Granting some is not wrong (they may
    // switch later), but silently doing nothing visible would be.
    const inert =
      account.ai_configs?.credit_mode === 'byok'
        ? ' Note: this workspace runs the agent on its own provider key, so' +
          ' credits stay unused until it switches to platform mode.'
        : '';

    return {
      ok:
        `${direction === 'add' ? 'Added' : 'Deducted'} ${Math.abs(applied)} ` +
        `credit(s). Balance is now ${balance}.${short}${inert}`,
    };
  } catch (error) {
    return toState(error, 'credit adjustment');
  }
}

/**
 * Repricing a pack.
 *
 * The price is typed in major units (299) and stored as minor (29900) — the
 * conversion happens here and nowhere else on the write path, mirroring
 * `minorToMajor` on the read path. `currency` is deliberately not editable:
 * changing it would reprice a pack by a factor of nothing anybody chose, and a
 * second-currency price list needs a real decision about which customers see
 * which packs.
 *
 * Unlike the subscription side, editing this price does NOT rewrite history —
 * `ai_credit_orders.amount_minor` records what each customer was actually
 * charged, so past sales keep their own numbers.
 */
export async function updateCreditPack(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await requireAdmin();

  try {
    const packId = uuid(formData, 'packId', 'Pack');
    const displayName = text(formData, 'displayName', 'Display name');
    const credits = integer(formData, 'credits', {
      label: 'Credits',
      min: 1,
      max: 10_000_000,
    })!;
    const priceMajor = decimal(formData, 'price', { label: 'Price', min: 0 });
    const badge = optionalText(formData, 'badge');
    const sortOrder = integer(formData, 'sortOrder', {
      label: 'Sort order',
      min: 0,
      max: 9999,
    })!;
    const isActive = boolean(formData, 'isActive');

    const priceMinor = Math.round(priceMajor * 100);
    if (priceMinor <= 0) {
      // `price_minor > 0` is a CHECK constraint, so this would be a 500 rather
      // than a message on the form. A free pack is also a mint-your-own-credits
      // button: the checkout would succeed with nothing collected.
      throw new FieldError(
        'Price must be greater than zero. To stop selling a pack, untick ' +
          '"Offered to customers" instead.'
      );
    }

    const pack = await prisma.ai_credit_packs.findUnique({
      where: { id: packId },
      select: { code: true, currency: true, credits: true, price_minor: true },
    });
    if (!pack) throw new FieldError('That pack no longer exists.');

    await prisma.ai_credit_packs.update({
      where: { id: packId },
      data: {
        display_name: displayName,
        credits,
        price_minor: BigInt(priceMinor),
        badge,
        sort_order: sortOrder,
        is_active: isActive,
        updated_at: new Date(),
      },
    });

    await recordAudit({
      actor: session.username,
      action: 'credit_pack.update',
      targetType: 'credit_pack',
      targetId: packId,
      summary:
        `Repriced credit pack ${pack.code}: ${pack.credits} credits at ` +
        `${Number(pack.price_minor) / 100} → ${credits} at ${priceMinor / 100}`,
      detail: {
        code: pack.code,
        currency: pack.currency,
        from: { credits: pack.credits, priceMinor: Number(pack.price_minor) },
        to: { credits, priceMinor },
        isActive,
      },
    });

    refresh();

    return {
      ok: `Saved ${pack.code}.${await packLadderWarning(packId)}`,
    };
  } catch (error) {
    return toState(error, 'credit pack write');
  }
}

/**
 * A bigger pack that costs more per credit than a smaller one is never intended,
 * and it is invisible until a customer notices the volume discount runs
 * backwards. Reported as a note on a successful save rather than a rejection:
 * an operator repricing the whole ladder passes through inconsistent states on
 * the way, and refusing the first edit would make the job impossible.
 */
async function packLadderWarning(packId: string): Promise<string> {
  const packs = await prisma.ai_credit_packs.findMany({
    where: { is_active: true },
    select: { id: true, code: true, credits: true, price_minor: true },
    orderBy: { credits: 'asc' },
  });

  const perCredit = packs.map((pack) => ({
    ...pack,
    rate: Number(pack.price_minor) / pack.credits,
  }));

  const offenders = perCredit.filter((pack, index) =>
    perCredit.slice(0, index).some((smaller) => smaller.rate < pack.rate)
  );

  if (offenders.length === 0) return '';

  const mine = offenders.some((pack) => pack.id === packId);
  return (
    ` Heads up: ${offenders.map((p) => p.code).join(', ')} now cost more per ` +
    `credit than a smaller pack, so the volume discount runs backwards` +
    `${mine ? '' : ' (not this pack, but the ladder it sits in)'}.`
  );
}

function toState(error: unknown, what: string): ActionState {
  if (error instanceof FieldError) return { error: error.message };
  console.error(`[admin-panel] ${what} failed`, error);
  return { error: `Could not save that change. Check the logs.` };
}
