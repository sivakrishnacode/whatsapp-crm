/**
 * Pricing page - displays subscription plans and allows upgrades
 */

"use client";

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { getPlanByName, formatLimit, type PlanName } from '@/lib/subscription';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Loader2, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRouter } from 'next/navigation';

// Load Razorpay checkout script
declare global {
  interface Window {
    Razorpay: any;
  }
}

const planTiers: Record<PlanName, number> = {
  'FREE': 0,
  'STARTER': 1,
  'GROWTH': 2,
};

export default function PricingPage() {
  const { user, subscription, subscriptionLoading } = useAuth();
  const router = useRouter();
  const [selectedPlan, setSelectedPlan] = useState<PlanName | null>(null);
  const [paymentLoading, setPaymentLoading] = useState(false);

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

  const plans: PlanName[] = ['FREE', 'STARTER', 'GROWTH'];
  const currentPlan = subscription?.plan_name || 'FREE';

  // Read plan query parameter to trigger upgrade flow automatically
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const planParam = params.get('plan')?.toUpperCase() as PlanName | null;
      if (planParam && plans.includes(planParam) && planParam !== currentPlan && planParam !== 'FREE') {
        setSelectedPlan(planParam);
      }
    }
  }, [currentPlan]);

  if (subscriptionLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  const handleUpgrade = async (planName: PlanName) => {
    if (!user) {
      toast.error('Please sign in to upgrade your plan');
      return;
    }

    if (planName === 'FREE') {
      toast.error('Cannot downgrade to FREE plan. Please contact support.');
      return;
    }

    setSelectedPlan(planName);
  };

  const handleStripeUpgrade = async (planName: PlanName) => {
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

  const handleRazorpayUpgrade = async (planName: PlanName) => {
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

      const options = {
        key: 'rzp_test_TCs9rejtWDeydM',
        order_id: data.orderId,
        amount: data.amount,
        currency: data.currency,
        name: 'WhatsApp CRM',
        description: `${planName} Plan - Monthly`,
        handler: async function (response: any) {
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
          color: '#3b82f6',
        },
      };

      const razorpay = (window as any).Razorpay;
      const rzp = new razorpay(options);
      rzp.open();
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

        <div className="grid md:grid-cols-3 gap-8">
          {plans.map((planName) => {
            const plan = getPlanByName(planName);
            const isCurrentPlan = planName === currentPlan;
            const isPopular = planName === 'STARTER';
            const isDowngrade = planTiers[planName] < planTiers[currentPlan];

            return (
              <Card
                key={planName}
                className={`relative overflow-visible ${isCurrentPlan ? 'border-primary border-2' : ''
                  } ${isPopular ? 'scale-105' : ''}`}
              >
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-primary text-primary-foreground text-xs font-bold px-3 py-1 rounded-full">
                      MOST POPULAR
                    </span>
                  </div>
                )}
                <CardHeader>
                  <CardTitle className="text-2xl">{plan.display_name}</CardTitle>
                  <CardDescription>{plan.description}</CardDescription>
                  <div className="mt-4">
                    <span className="text-4xl font-bold">
                      ₹{plan.price_monthly}
                    </span>
                    <span className="text-muted-foreground">/month</span>
                    {plan.price_yearly > 0 && (
                      <div className="text-sm text-muted-foreground mt-1">
                        ₹{plan.price_yearly}/year (save {Math.round((1 - plan.price_yearly / (plan.price_monthly * 12)) * 100)}%)
                      </div>
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
                      <div>Contacts: {formatLimit(plan.max_contacts)}</div>
                      <div>Messages/month: {formatLimit(plan.max_messages_monthly)}</div>
                      <div>Broadcasts/month: {formatLimit(plan.max_broadcasts_monthly)}</div>
                      <div>Flows: {formatLimit(plan.max_flows)}</div>
                      <div>Team members: {formatLimit(plan.max_team_members)}</div>
                      <div>Storage: {formatLimit(plan.max_storage_mb)} MB</div>
                      {plan.trial_days && (
                        <div className="text-primary font-medium">
                          {plan.trial_days} days free trial
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
                    onClick={() => handleUpgrade(planName)}
                  >
                    {isCurrentPlan ? 'Current Plan' : isDowngrade ? 'Downgrade' : planName === 'FREE' ? 'Get Started' : 'Upgrade'}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>

        <div className="mt-12 text-center text-sm text-muted-foreground">
          <p>All plans include core CRM features. Need a custom plan? Contact us for enterprise solutions.</p>
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
                  {/* <span className="text-xs text-muted-foreground">Credit/Debit Cards</span> */}
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
    </div>
  );
}
