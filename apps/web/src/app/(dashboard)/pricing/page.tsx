/**
 * Pricing page — the upgrade surface for an account that is already in
 * the product. The mandatory first choice happens in the /welcome
 * wizard; this is where a plan gets changed or a trial converted.
 */

"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { usePlans, type Plan } from '@/hooks/use-plans';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EnterpriseEnquiryDialog } from '@/components/onboarding/enterprise-enquiry-dialog';
import { submitEnquiry, type EnquiryPayload } from '@/lib/onboarding/api';

/**
 * The slice of Razorpay's checkout API this page uses. Typed here
 * rather than pulled from a package: the SDK ships as a script tag, so
 * there is no module to import types from.
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

interface RazorpayCheckout {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayCheckout;
  }
}

/** null on a limit column means unlimited, not zero. */
function formatLimit(value: number | null): string {
  return value === null ? 'Unlimited' : value.toLocaleString();
}

export default function PricingPage() {
  const { user, subscription, subscriptionLoading } = useAuth();
  const { plans, isLoading: plansLoading, error: plansError } = usePlans();
  const router = useRouter();

  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [enquiryOpen, setEnquiryOpen] = useState(false);
  const [enquirySubmitting, setEnquirySubmitting] = useState(false);

  // Load Razorpay checkout script
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  const currentPlan = subscription?.plan_name ?? null;

  // Price order is the tier order — it comes from the API sorted
  // ascending, so no second ranking table to keep in sync.
  const planRank = new Map(plans.map((plan, index) => [plan.name, index]));

  // Read plan query parameter to trigger upgrade flow automatically
  useEffect(() => {
    if (typeof window === 'undefined' || plans.length === 0) return;

    const params = new URLSearchParams(window.location.search);
    const planParam = params.get('plan')?.toUpperCase();
    if (!planParam || planParam === currentPlan) return;

    const target = plans.find((plan) => plan.name === planParam);
    if (!target) return;
    if (target.isEnquiryOnly) setEnquiryOpen(true);
    else setSelectedPlan(planParam);
  }, [currentPlan, plans]);

  if (subscriptionLoading || plansLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  const handleChoose = (plan: Plan) => {
    if (!user) {
      toast.error('Please sign in to change your plan');
      return;
    }

    if (plan.isEnquiryOnly) {
      setEnquiryOpen(true);
      return;
    }

    setSelectedPlan(plan.name);
  };

  const handleEnquiry = async (payload: EnquiryPayload) => {
    setEnquirySubmitting(true);
    try {
      await submitEnquiry(payload);
      toast.success("Thanks — we'll be in touch shortly.");
      setEnquiryOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send enquiry');
    } finally {
      setEnquirySubmitting(false);
    }
  };

  const handleStripeUpgrade = async (planName: string) => {
    setPaymentLoading(true);
    try {
      const response = await fetch('/api/subscription/stripe/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          planName,
          billingCycle: 'monthly',
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.error || 'Failed to create Stripe checkout session');
        return;
      }

      if (data.url) {
        window.location.href = data.url;
      } else {
        toast.error('No checkout URL returned from Stripe');
      }
    } catch (error) {
      console.error('Stripe payment error:', error);
      toast.error('Failed to initiate Stripe payment');
    } finally {
      setPaymentLoading(false);
    }
  };

  const handleRazorpayUpgrade = async (planName: string) => {
    // Publishable key — safe in the client, but it differs between test
    // and live and must not be baked into the bundle as a literal.
    const razorpayKey = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    if (!razorpayKey) {
      toast.error('Payments are not configured. Please contact support.');
      return;
    }

    setPaymentLoading(true);
    try {
      const response = await fetch('/api/subscription/razorpay/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          planName,
          billingCycle: 'monthly',
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.error || 'Failed to create payment order');
        return;
      }

      const options: RazorpayOptions = {
        key: razorpayKey,
        order_id: data.orderId,
        amount: data.amount,
        currency: data.currency,
        name: 'Converse360',
        description: `${planName} Plan - Monthly`,
        handler: async function (response: RazorpayPaymentResponse) {
          try {
            const confirmResponse = await fetch('/api/subscription/razorpay/confirm-payment', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                planName,
                billingCycle: 'monthly',
                razorpayOrderId: data.orderId,
                razorpayPaymentId: response.razorpay_payment_id,
              }),
            });

            if (confirmResponse.ok) {
              toast.success('Payment successful! Your plan has been upgraded.');
              window.location.reload();
            } else {
              toast.error('Payment successful but failed to update subscription. Please contact support.');
            }
          } catch (error) {
            console.error('Error confirming payment:', error);
            toast.error('Payment successful but failed to update subscription. Please contact support.');
          }
        },
        prefill: {
          name: user?.user_metadata?.full_name || '',
          email: user?.email || '',
        },
        theme: {
          color: '#00ac55',
        },
      };

      const Razorpay = window.Razorpay;
      if (!Razorpay) {
        toast.error('Checkout failed to load. Please refresh and try again.');
        return;
      }
      new Razorpay(options).open();
    } catch (error) {
      console.error('Payment error:', error);
      toast.error('Failed to initiate payment');
    } finally {
      setPaymentLoading(false);
      setSelectedPlan(null);
    }
  };

  return (
    <div className="container mx-auto py-10 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 flex justify-start">
          <Button
            variant="ghost"
            onClick={() => router.back()}
            className="flex items-center gap-2 hover:bg-accent/50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </div>
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold mb-4">Choose Your Plan</h1>
          <p className="text-muted-foreground text-lg">
            Select the perfect plan for your business needs
          </p>
          {subscription && (
            <div className="mt-4 inline-flex items-center px-4 py-2 bg-primary/10 rounded-full">
              <span className="text-sm font-medium">
                Current Plan: <span className="font-bold">{subscription.plan_display_name}</span>
              </span>
            </div>
          )}
        </div>

        {plansError ? (
          <p className="text-center text-sm text-destructive">{plansError}</p>
        ) : null}

        <div className="grid md:grid-cols-3 gap-8">
          {plans.map((plan) => {
            const isCurrentPlan = plan.name === currentPlan;
            // Middle tier of three — the default recommendation.
            const isPopular = planRank.get(plan.name) === 1;
            const currentRank = currentPlan ? planRank.get(currentPlan) : undefined;
            const isDowngrade =
              currentRank !== undefined &&
              (planRank.get(plan.name) ?? 0) < currentRank;

            return (
              <Card
                key={plan.name}
                className={cn(
                  'relative overflow-visible',
                  isCurrentPlan && 'border-primary border-2',
                  isPopular && 'scale-105',
                )}
              >
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-primary text-primary-foreground text-xs font-bold px-3 py-1 rounded-full">
                      MOST POPULAR
                    </span>
                  </div>
                )}
                <CardHeader>
                  <CardTitle className="text-2xl">{plan.displayName}</CardTitle>
                  <CardDescription>{plan.description}</CardDescription>
                  <div className="mt-4">
                    {plan.isEnquiryOnly ? (
                      <span className="text-2xl font-bold">Custom pricing</span>
                    ) : (
                      <>
                        <span className="text-4xl font-bold">
                          ₹{plan.priceMonthly.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground">/month</span>
                        {plan.priceYearly > 0 && (
                          <div className="text-sm text-muted-foreground mt-1">
                            ₹{plan.priceYearly.toLocaleString()}/year (save{' '}
                            {Math.round((1 - plan.priceYearly / (plan.priceMonthly * 12)) * 100)}%)
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <h3 className="font-semibold text-sm">Features</h3>
                    {plan.features.map((feature) => (
                      <div key={feature} className="flex items-center gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary" />
                        <span>{feature}</span>
                      </div>
                    ))}
                  </div>
                  <div className="pt-4 border-t">
                    <h3 className="font-semibold text-sm mb-2">Limits</h3>
                    <div className="space-y-1 text-sm text-muted-foreground">
                      <div>Contacts: {formatLimit(plan.maxContacts)}</div>
                      <div>Messages/month: {formatLimit(plan.maxMessagesMonthly)}</div>
                      <div>Broadcasts/month: {formatLimit(plan.maxBroadcastsMonthly)}</div>
                      <div>Flows: {formatLimit(plan.maxFlows)}</div>
                      <div>Team members: {formatLimit(plan.maxTeamMembers)}</div>
                      <div>Storage: {formatLimit(plan.maxStorageMb)} MB</div>
                      {plan.trialDays && (
                        <div className="text-primary font-medium">
                          {plan.trialDays} days free trial
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
                <CardFooter>
                  <Button
                    className="w-full"
                    variant={isCurrentPlan ? 'outline' : 'default'}
                    disabled={isCurrentPlan}
                    onClick={() => handleChoose(plan)}
                  >
                    {isCurrentPlan
                      ? 'Current Plan'
                      : plan.isEnquiryOnly
                        ? 'Talk to sales'
                        : isDowngrade
                          ? 'Downgrade'
                          : 'Upgrade'}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>

      <Dialog open={selectedPlan !== null} onOpenChange={(open) => !open && setSelectedPlan(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Select Payment Method</DialogTitle>
            <DialogDescription>
              Choose your preferred payment gateway to subscribe to the <span className="font-bold text-foreground">{selectedPlan}</span> plan.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-4">
            <Button
              variant="outline"
              className="h-24 flex flex-col items-center justify-center gap-2 border-2 hover:border-primary hover:bg-primary/5 transition-all"
              disabled={true}
              onClick={() => selectedPlan && handleStripeUpgrade(selectedPlan)}
            >
              {paymentLoading ? (
                <Loader2 className="h-6 w-6 animate-spin" />
              ) : (
                <>
                  <span className="font-bold text-lg">Stripe</span>
                  <span className="text-xs text-muted-foreground">Currently Not Available</span>
                </>
              )}
            </Button>
            <Button
              variant="outline"
              className="h-24 flex flex-col items-center justify-center gap-2 border-2 hover:border-primary hover:bg-primary/5 transition-all"
              disabled={paymentLoading}
              onClick={() => selectedPlan && handleRazorpayUpgrade(selectedPlan)}
            >
              {paymentLoading ? (
                <Loader2 className="h-6 w-6 animate-spin" />
              ) : (
                <>
                  <span className="font-bold text-lg">Razorpay</span>
                  <span className="text-xs text-muted-foreground">UPI, Cards, Netbanking</span>
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <EnterpriseEnquiryDialog
        open={enquiryOpen}
        onOpenChange={setEnquiryOpen}
        defaultName={(user?.user_metadata?.full_name as string) ?? ''}
        defaultEmail={user?.email ?? ''}
        companySize={null}
        submitting={enquirySubmitting}
        onSubmit={handleEnquiry}
      />
    </div>
  );
}
