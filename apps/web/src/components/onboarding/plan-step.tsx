"use client";

import { useTranslations } from "next-intl";
import { Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { OnboardingPlan } from "@/lib/onboarding/api";

/**
 * Which card gets the badge: the second one.
 *
 * Plans arrive cheapest-first with the quoted tier last, so index 1 is
 * the middle of three — where a pricing table's recommendation belongs.
 * Positional rather than a hardcoded plan name so renaming a tier in
 * the admin panel doesn't silently drop the badge. Same rule as
 * /pricing.
 */
const POPULAR_INDEX = 1;

/** null on max_flows and friends means unlimited, not zero. */
function formatLimit(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString();
}

function formatStorage(megabytes: number): string {
  if (megabytes >= 1024) return `${Math.round(megabytes / 1024)}GB`;
  return `${megabytes}MB`;
}

/**
 * Step 2 — the mandatory plan choice.
 *
 * Prices come from the API rather than the hardcoded DEFAULT_PLANS
 * table, so a price edited in the admin panel shows up here without a
 * deploy. Enterprise arrives flagged `isEnquiryOnly` and renders a
 * "talk to sales" button instead of a price.
 */
export function PlanStep({
  plans,
  pendingPlan,
  onSelect,
  onEnquire,
}: {
  plans: OnboardingPlan[];
  /** Name of the plan mid-request, so only its own button spins. */
  pendingPlan: string | null;
  onSelect: (planName: string) => void;
  onEnquire: () => void;
}) {
  const t = useTranslations("WelcomePage");

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {plans.map((plan, index) => {
        const isPopular = index === POPULAR_INDEX;
        const isPending = pendingPlan === plan.name;
        const isBusy = pendingPlan !== null;

        return (
          <div
            key={plan.name}
            className={cn(
              "relative flex flex-col gap-6 rounded-xl border bg-card p-6",
              isPopular ? "border-primary shadow-sm" : "border-border",
            )}
          >
            {isPopular ? (
              <span className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                {t("mostPopular")}
              </span>
            ) : null}

            <div className="flex flex-col gap-2">
              <h3 className="font-heading text-lg font-semibold">
                {plan.displayName}
              </h3>
              {plan.description ? (
                <p className="text-sm text-muted-foreground">
                  {plan.description}
                </p>
              ) : null}
            </div>

            <div className="flex items-baseline gap-1">
              {plan.isEnquiryOnly ? (
                <span className="text-2xl font-bold">
                  {t("customPricing")}
                </span>
              ) : (
                <>
                  <span className="text-3xl font-bold">
                    ₹{plan.priceMonthly.toLocaleString()}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t("perMonth")}
                  </span>
                </>
              )}
            </div>

            {plan.trialDays ? (
              <span className="w-fit rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                {t("trialBadge", { days: plan.trialDays })}
              </span>
            ) : null}

            <ul className="flex flex-1 flex-col gap-2 text-sm">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            <dl className="flex flex-col gap-1 border-t pt-4 text-xs text-muted-foreground">
              <LimitRow term="Contacts" value={formatLimit(plan.maxContacts)} />
              <LimitRow
                term="Messages / month"
                value={formatLimit(plan.maxMessagesMonthly)}
              />
              <LimitRow term="Flows" value={formatLimit(plan.maxFlows)} />
              <LimitRow
                term="Team members"
                value={formatLimit(plan.maxTeamMembers)}
              />
              <LimitRow
                term="Storage"
                value={formatStorage(plan.maxStorageMb)}
              />
            </dl>

            <Button
              className="h-11 w-full"
              variant={isPopular ? "default" : "outline"}
              disabled={isBusy}
              onClick={() =>
                plan.isEnquiryOnly ? onEnquire() : onSelect(plan.name)
              }
            >
              {isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("starting")}
                </>
              ) : plan.isEnquiryOnly ? (
                t("contactSales")
              ) : (
                t("startTrial")
              )}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function LimitRow({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt>{term}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
