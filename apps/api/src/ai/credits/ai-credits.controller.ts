import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import Razorpay from 'razorpay';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { RequireRole } from '../../auth/decorators/require-role.decorator';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';
import { PrismaService } from '../../prisma/prisma.service';
import { AiCreditsService } from './ai-credits.service';
import {
  LOW_BALANCE_THRESHOLD,
  WEIGHTED_TOKENS_PER_CREDIT,
  isPlatformAiAvailable,
} from './credits.constants';

/**
 * ============================================================
 * AI credits: the wallet, the price list, and top-ups.
 *
 * ⚠️ THE AMOUNT IS NEVER TAKEN FROM THE REQUEST. `create-order` looks
 * the pack up in `ai_credit_packs` and writes what it decided into
 * `ai_credit_orders` before the customer is redirected; `verify` then
 * compares Razorpay's own record against that row. A client that posts
 * `{credits: 25000, amount: 1}` gets the pack's real price, and a
 * client that posts a forged success gets a signature failure.
 *
 * This is deliberately stricter than the existing plan-checkout
 * endpoint next door (`subscription/razorpay/confirm-payment`), which
 * trusts the browser's word that a payment happened. That endpoint
 * should be brought up to this standard — see the note in the plan
 * summary; it is a live hole, not a style difference.
 * ============================================================
 */
@Controller('ai/credits')
export class AiCreditsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: AiCreditsService,
  ) {}

  private razorpay() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      throw new HttpException(
        'Card payments are not configured on this server.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      rzp: new Razorpay({ key_id: keyId, key_secret: keySecret }),
      keyId,
      keySecret,
    };
  }

  /**
   * GET /api/ai/credits
   * Balance + the price list. Any signed-in member: the header badge
   * renders for everyone, and an agent who cannot draft needs to know
   * why without being told to ask an admin.
   */
  @Get()
  @UseGuards(SupabaseAuthGuard)
  async getCredits(@CurrentAccount() account: SupabaseAccountContext) {
    const [wallet, packs, config] = await Promise.all([
      this.credits.getWallet(account.accountId),
      this.prisma.ai_credit_packs.findMany({
        where: { is_active: true },
        orderBy: { sort_order: 'asc' },
        select: {
          code: true,
          display_name: true,
          credits: true,
          price_minor: true,
          currency: true,
          badge: true,
        },
      }),
      this.prisma.ai_configs.findUnique({
        where: { account_id: account.accountId },
        select: { credit_mode: true, api_key: true },
      }),
    ]);

    return {
      balance: wallet.balance,
      low: wallet.low,
      low_threshold: LOW_BALANCE_THRESHOLD,
      lifetime_purchased: wallet.lifetimePurchased,
      lifetime_consumed: wallet.lifetimeConsumed,
      // What the workspace chose, and whether that choice can be
      // honoured. The badge hides itself entirely on a byok workspace —
      // a credit count is meaningless when nothing spends it.
      credit_mode: config?.credit_mode === 'byok' ? 'byok' : 'platform',
      has_own_key: Boolean(config?.api_key),
      platform_available: isPlatformAiAvailable(),
      weighted_tokens_per_credit: WEIGHTED_TOKENS_PER_CREDIT,
      packs: packs.map((p) => ({
        code: p.code,
        display_name: p.display_name,
        credits: p.credits,
        // Minor units all the way to the browser. The UI formats it;
        // nothing in between rounds it into a float.
        price_minor: Number(p.price_minor),
        currency: p.currency,
        badge: p.badge,
      })),
    };
  }

  /**
   * GET /api/ai/credits/ledger
   * Spend history. Admin+ — it is a billing record.
   */
  @Get('ledger')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('admin')
  async getLedger(
    @CurrentAccount() account: SupabaseAccountContext,
    @Query('limit') limit?: string,
  ) {
    const rows = await this.credits.listLedger(
      account.accountId,
      Number(limit) || 50,
    );
    return { entries: rows };
  }

  /**
   * POST /api/ai/credits/mode
   * Switch between our credits and their own key. Admin+, because it
   * decides who gets billed for every reply the agent sends.
   */
  @Post('mode')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('admin')
  async setMode(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { credit_mode?: string },
  ) {
    const mode = body?.credit_mode;
    if (mode !== 'platform' && mode !== 'byok') {
      throw new HttpException(
        'credit_mode must be "platform" or "byok".',
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.prisma.ai_configs.findUnique({
      where: { account_id: account.accountId },
      select: { id: true, api_key: true },
    });

    // Choosing "my own key" without one stored would switch the agent
    // off on the next message, silently. Refusing is the honest answer:
    // the key comes first, then the mode.
    if (mode === 'byok' && !existing?.api_key) {
      throw new HttpException(
        {
          error:
            'Add your provider key first — there is nothing to switch to yet.',
          code: 'no_own_key',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (mode === 'platform' && !isPlatformAiAvailable()) {
      throw new HttpException(
        {
          error: 'Built-in AI is not available on this server.',
          code: 'platform_ai_unavailable',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (existing) {
      await this.prisma.ai_configs.update({
        where: { account_id: account.accountId },
        data: { credit_mode: mode },
      });
    } else {
      // A workspace running on the platform default has no row yet.
      // Creating one here records the choice without demanding a key.
      await this.prisma.ai_configs.create({
        data: {
          account_id: account.accountId,
          created_by: account.userId,
          provider: 'gemini',
          model: 'gemini-3.5-flash-lite',
          credit_mode: mode,
          is_active: true,
          auto_reply_enabled: false,
        },
      });
    }

    return { success: true, credit_mode: mode };
  }

  /**
   * POST /api/ai/credits/order
   * Start a top-up. Owner/admin only — it spends the business's money.
   */
  @Post('order')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('admin')
  async createOrder(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body() body: { pack_code?: string },
  ) {
    const packCode = typeof body?.pack_code === 'string' ? body.pack_code : '';
    if (!packCode) {
      throw new HttpException('pack_code is required', HttpStatus.BAD_REQUEST);
    }

    // The price comes from here and nowhere else.
    const pack = await this.prisma.ai_credit_packs.findFirst({
      where: { code: packCode, is_active: true },
    });
    if (!pack) {
      throw new HttpException('Unknown credit pack', HttpStatus.NOT_FOUND);
    }

    const { rzp, keyId } = this.razorpay();

    // The row is written BEFORE Razorpay is told anything, so a payment
    // that completes while our response is in flight still has a row to
    // land on when the webhook arrives.
    const order = await this.prisma.ai_credit_orders.create({
      data: {
        account_id: account.accountId,
        user_id: account.userId,
        pack_id: pack.id,
        pack_code: pack.code,
        credits: pack.credits,
        amount_minor: pack.price_minor,
        currency: pack.currency,
        status: 'created',
      },
      select: { id: true },
    });

    try {
      const rzpOrder = await rzp.orders.create({
        amount: Number(pack.price_minor),
        currency: pack.currency,
        receipt: `aic_${order.id.slice(0, 18)}`,
        notes: {
          kind: 'ai_credits',
          orderId: order.id,
          accountId: account.accountId,
          packCode: pack.code,
        },
      });

      await this.prisma.ai_credit_orders.update({
        where: { id: order.id },
        data: { gateway_order_id: rzpOrder.id, updated_at: new Date() },
      });

      return {
        order_id: order.id,
        gateway_order_id: rzpOrder.id,
        amount_minor: Number(rzpOrder.amount),
        currency: rzpOrder.currency,
        credits: pack.credits,
        key_id: keyId,
      };
    } catch {
      // The row stays as evidence that a purchase was attempted, marked
      // failed so it can never be mistaken for an unpaid pending order.
      await this.prisma.ai_credit_orders
        .update({ where: { id: order.id }, data: { status: 'failed' } })
        .catch(() => undefined);
      throw new HttpException(
        'Could not start the payment. Try again.',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * POST /api/ai/credits/verify
   * Razorpay Checkout's success callback.
   *
   * The signature is the whole security of this endpoint: Razorpay
   * signs `<order_id>|<payment_id>` with our key secret, which the
   * browser does not have. Without this check, "I paid" would be a
   * claim anyone with a session could make, which is exactly the shape
   * of the hole in the plan-checkout endpoint next door.
   */
  @Post('verify')
  @UseGuards(SupabaseAuthGuard)
  @RequireRole('admin')
  async verifyPayment(
    @CurrentAccount() account: SupabaseAccountContext,
    @Body()
    body: {
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    },
  ) {
    const orderId = body?.razorpay_order_id?.trim();
    const paymentId = body?.razorpay_payment_id?.trim();
    const signature = body?.razorpay_signature?.trim();

    if (!orderId || !paymentId || !signature) {
      throw new HttpException(
        'Missing payment confirmation fields',
        HttpStatus.BAD_REQUEST,
      );
    }

    const { keySecret } = this.razorpay();
    const expected = createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const given = Buffer.from(signature, 'utf8');
    const want = Buffer.from(expected, 'utf8');
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new HttpException(
        { error: 'Payment could not be verified.', code: 'bad_signature' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Scoped to the caller's own account: a valid signature proves a
    // payment happened, not that it was THIS workspace's payment.
    const order = await this.prisma.ai_credit_orders.findFirst({
      where: { gateway_order_id: orderId, account_id: account.accountId },
    });
    if (!order) {
      throw new HttpException('Order not found', HttpStatus.NOT_FOUND);
    }

    // The grant itself is in the service, because Razorpay's webhook
    // grants through the same code — a customer who pays and closes the
    // tab before this callback fires must still get their credits.
    const balance = await this.credits.creditOrder(order.id, paymentId);
    return { success: true, credits: order.credits, balance };
  }
}
