/**
 * Pricing settings panel - displays current subscription and plan options
 * Admin-only section
 */

"use client";

import { useAuth } from '@/hooks/use-auth';
import { getPlanByName, formatLimit, type PlanName } from '@/lib/subscription';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Check, Loader2, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

const planTiers: Record<PlanName, number> = {
  'FREE': 0,
  'STARTER': 1,
  'GROWTH': 2,
};

export function PricingSettings() {
  const { user, subscription, subscriptionLoading, canEditSettings } = useAuth();

  if (!canEditSettings) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">You don't have permission to view this section.</p>
      </div>
    );
  }

  if (subscriptionLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  const plans: PlanName[] = ['FREE', 'STARTER', 'GROWTH'];
  const currentPlan = subscription?.plan_name || 'FREE';

  const handleUpgrade = async (planName: PlanName) => {
    if (planName === 'FREE') {
      toast.error('Cannot downgrade to FREE plan. Please contact support.');
      return;
    }

    // For now, redirect to pricing page
    // This will be replaced with actual payment integration
    window.location.href = '/pricing';
  };

  const handleManageSubscriptions = () => {
    window.location.href = '/admin/subscriptions';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Pricing & Plans</h2>
        <p className="text-muted-foreground">
          Manage your subscription and view plan options
        </p>
      </div>

      {/* Current Subscription */}
      <Card>
        <CardHeader>
          <CardTitle>Current Subscription</CardTitle>
          <CardDescription>Your active plan and billing status</CardDescription>
        </CardHeader>
        <CardContent>
          {subscription ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">{subscription.plan_display_name}</div>
                  <div className="text-sm text-muted-foreground">
                    {subscription.status === 'trial' && subscription.trial_end_at
                      ? `Trial ends ${new Date(subscription.trial_end_at).toLocaleDateString()}`
                      : subscription.status === 'active'
                      ? 'Active subscription'
                      : subscription.status}
                  </div>
                </div>
                <Badge variant={subscription.status === 'active' ? 'default' : 'secondary'}>
                  {subscription.status}
                </Badge>
              </div>

              {subscription.billing_cycle && (
                <div className="text-sm text-muted-foreground">
                  Billing: {subscription.billing_cycle}
                  {subscription.current_period_end && (
                    <span>
                      {' • Next billing: '}
                      {new Date(subscription.current_period_end).toLocaleDateString()}
                    </span>
                  )}
                </div>
              )}

              <div className="pt-4 border-t">
                <h4 className="font-semibold mb-2">Current Limits</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>Contacts: {formatLimit(subscription.max_contacts)}</div>
                  <div>Messages/month: {formatLimit(subscription.max_messages_monthly)}</div>
                  <div>Broadcasts/month: {formatLimit(subscription.max_broadcasts_monthly)}</div>
                  <div>Flows: {formatLimit(subscription.max_flows)}</div>
                  <div>Team members: {formatLimit(subscription.max_team_members)}</div>
                  <div>Storage: {formatLimit(subscription.max_storage_mb)} MB</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground">No subscription found</div>
          )}
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={handleManageSubscriptions}>
            <ExternalLink className="h-4 w-4 mr-2" />
            Manage All Subscriptions
          </Button>
        </CardFooter>
      </Card>

      {/* Plan Options */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Available Plans</h3>
        <div className="grid md:grid-cols-3 gap-4">
          {plans.map((planName) => {
            const plan = getPlanByName(planName);
            const isCurrentPlan = planName === currentPlan;
            const isPopular = planName === 'STARTER';
            const isDowngrade = planTiers[planName] < planTiers[currentPlan];

            return (
              <Card
                key={planName}
                className={`relative overflow-visible ${isCurrentPlan ? 'border-primary border-2' : ''} ${
                  isPopular ? 'scale-105' : ''
                }`}
              >
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-primary text-primary-foreground text-xs font-bold px-3 py-1 rounded-full">
                      MOST POPULAR
                    </span>
                  </div>
                )}
                <CardHeader>
                  <CardTitle className="text-xl">{plan.display_name}</CardTitle>
                  <CardDescription>{plan.description}</CardDescription>
                  <div className="mt-4">
                    <span className="text-3xl font-bold">₹{plan.price_monthly}</span>
                    <span className="text-muted-foreground">/month</span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-2">
                    {plan.features.slice(0, 4).map((feature) => (
                      <div key={feature} className="flex items-center gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary" />
                        <span>{feature}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
                <CardFooter>
                  <Button
                    className="w-full"
                    variant={isCurrentPlan ? 'outline' : 'default'}
                    disabled={isCurrentPlan}
                    onClick={() => handleUpgrade(planName)}
                  >
                    {isCurrentPlan ? 'Current Plan' : isDowngrade ? 'Downgrade' : 'Upgrade'}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
