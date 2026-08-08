'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, Sparkles, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useAuth } from '@/hooks/use-auth';
import { useAiCredits, type CreditPack } from '@/hooks/use-ai-credits';
import { canEditSettings } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';

/**
 * Razorpay ships as a script tag, so there is no module to import types
 * from. Only the slice this component uses is declared.
 */
interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
}

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  handler: (response: RazorpayPaymentResponse) => void;
  prefill: { name: string; email: string };
  theme: { color: string };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => { open: () => void };
  }
}

/** Minor units in, currency out. The server never sends a float. */
function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}

/** Per-credit price, which is the only way to compare packs honestly. */
function perCredit(pack: CreditPack): string {
  return formatPrice(Math.round(pack.price_minor / pack.credits), pack.currency)
    // A per-unit price under a rupee reads better with the paise.
    .replace(/^(\D+)0$/, '$1<1');
}

export function AiCreditsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { profile, accountRole } = useAuth();
  const { credits, reload } = useAiCredits();
  const [buying, setBuying] = useState<string | null>(null);
  const canBuy = accountRole ? canEditSettings(accountRole) : false;

  // Loaded only while the sheet is open: it is a third-party script on
  // every dashboard page otherwise, for a purchase most sessions never
  // make.
  useEffect(() => {
    if (!open) return;
    if (window.Razorpay) return;
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);
    return () => {
      script.remove();
    };
  }, [open]);

  const handleBuy = async (pack: CreditPack) => {
    const key = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    if (!key) {
      toast.error('Card payments are not configured.');
      return;
    }
    if (!window.Razorpay) {
      toast.error('Payment window is still loading — try again in a moment.');
      return;
    }

    setBuying(pack.code);
    try {
      // The server prices the pack; this request carries only which one.
      const res = await fetch('/api/ai/credits/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack_code: pack.code }),
      });
      const order = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(order?.error ?? 'Could not start the payment.');
        return;
      }

      new window.Razorpay({
        key,
        order_id: order.gateway_order_id,
        amount: order.amount_minor,
        currency: order.currency,
        name: 'converse360',
        description: `${pack.credits.toLocaleString()} AI credits`,
        prefill: {
          name: profile?.full_name ?? '',
          email: profile?.email ?? '',
        },
        theme: { color: '#2563eb' },
        handler: async (response) => {
          // The signature is what makes this trustworthy — the server
          // recomputes it and refuses anything it did not sign.
          const verify = await fetch('/api/ai/credits/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            }),
          });
          const result = await verify.json().catch(() => null);
          if (!verify.ok) {
            // The payment may still land: Razorpay's webhook grants the
            // credits independently of this callback, so "contact us"
            // would be the wrong advice.
            toast.error(
              result?.error ??
                'We could not confirm the payment here. If it was charged, your credits will appear shortly.',
            );
            await reload();
            return;
          }
          toast.success(
            `${pack.credits.toLocaleString()} credits added.`,
          );
          await reload();
          onOpenChange(false);
        },
      }).open();
    } catch {
      toast.error('Could not start the payment.');
    } finally {
      setBuying(null);
    }
  };

  const packs = credits?.packs ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            AI credits
          </SheetTitle>
          <SheetDescription>
            Credits pay for replies drafted, generated and indexed by the
            built-in AI. They never expire.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <p className="text-3xl font-semibold tabular-nums text-foreground">
              {(credits?.balance ?? 0).toLocaleString()}
            </p>
            <p className="text-sm text-muted-foreground">credits remaining</p>
            {credits && credits.lifetime_consumed > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {credits.lifetime_consumed.toLocaleString()} used all time
              </p>
            ) : null}
          </div>

          {/* A workspace on its own key is shown the balance but told
              plainly that nothing is spending it — otherwise a number
              that never moves reads as a bug. */}
          {credits?.credit_mode === 'byok' ? (
            <p className="flex items-start gap-2 rounded-lg border border-border bg-background p-3 text-sm text-muted-foreground">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>
                This workspace runs the AI on your own provider key, so these
                credits are not being spent. They stay here if you switch back.
              </span>
            </p>
          ) : credits?.low ? (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                Running low. At zero, the AI stops drafting and the auto-reply
                bot leaves conversations for a human.
              </span>
            </p>
          ) : null}

          {canBuy ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">Top up</p>
              {packs.map((pack) => (
                <button
                  key={pack.code}
                  type="button"
                  disabled={buying !== null}
                  onClick={() => void handleBuy(pack)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left transition-colors',
                    'hover:border-primary/50 hover:bg-muted/50',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                  )}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      {pack.credits.toLocaleString()} credits
                      {pack.badge ? (
                        <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                          {pack.badge}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {perCredit(pack)} per credit
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-2 text-sm font-semibold text-foreground">
                    {buying === pack.code ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    {formatPrice(pack.price_minor, pack.currency)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
              Ask a workspace admin to top up.
            </p>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            A credit is roughly one AI reply. Longer conversations, a large
            knowledge base or replies that look things up cost a little more,
            so what you spend tracks what you actually use.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
