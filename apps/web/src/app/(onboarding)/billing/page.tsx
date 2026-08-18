"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Loader2,
  Mail,
  MessageCircle,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Button, buttonVariants } from "@/components/ui/button";
import { AuthFormError } from "@/components/auth/auth-shell";
import { EnterpriseEnquiryDialog } from "@/components/onboarding/enterprise-enquiry-dialog";
import { useRazorpayCheckout } from "@/hooks/use-razorpay-checkout";
import {
  SUPPORT_EMAIL,
  trialExtensionMailto,
  trialExtensionWhatsApp,
} from "@/lib/billing/support";
import {
  fetchOnboardingState,
  submitEnquiry,
  type EnquiryPayload,
  type OnboardingPlan,
  type OnboardingState,
} from "@/lib/onboarding/api";

/**
 * `/billing` — the locked screen for a workspace whose trial is spent and
 * whose subscription has lapsed.
 *
 * WHY THIS IS ITS OWN SCREEN, OUTSIDE THE DASHBOARD
 *   A lapsed account used to be sent to `/welcome`, where the plan cards
 *   advertised a 15-day free trial and every button said "Start free
 *   trial". Pressing one could not work: `trial_granted_at` (migration
 *   074) is a one-time latch, so the server carried the lapsed window
 *   forward, the status stayed `expired`, and the wizard rendered the same
 *   picker again. Meanwhile `/pricing` — the one screen that takes money —
 *   sits inside the dashboard, behind the very gate doing the redirecting.
 *   The account was locked out with no exit and no explanation.
 *
 *   So this screen has exactly the three exits that actually exist: pay,
 *   ask a human for more time, or talk to sales. Nothing here offers a
 *   trial.
 *
 * WHY IT DOES NOT USE useAuth()
 *   `AuthProvider` is mounted by the dashboard shell, which this route is
 *   deliberately outside of. Everything it needs comes from
 *   `GET /api/onboarding`, which is also the only correct source for
 *   "is this person the owner?" — that is `accounts.owner_user_id`, not a
 *   role column a stale profile might disagree with.
 */
export default function BillingLockedPage() {
  const router = useRouter();

  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPlans, setShowPlans] = useState(false);
  const [enquiryOpen, setEnquiryOpen] = useState(false);
  const [enquirySubmitting, setEnquirySubmitting] = useState(false);
  const [identity, setIdentity] = useState({ name: "", email: "" });

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    supabase.auth.getUser().then(({ data }) => {
      if (!active || !data.user) return;
      setIdentity({
        name: (data.user.user_metadata?.full_name as string) ?? "",
        email: data.user.email ?? "",
      });
    });

    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(
    (onSettled?: (next: OnboardingState) => void) => {
      fetchOnboardingState()
        .then((next) => {
          setState(next);
          onSettled?.(next);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [],
  );

  useEffect(() => {
    // Anyone who does not belong here is bounced by the same rule that
    // sent them: an entitled account back to the dashboard, an unfinished
    // signup back to the wizard. This screen never decides on its own
    // whether the account is locked — the server does.
    load((next) => {
      if (next.step === "done") router.replace("/dashboard");
      else if (next.step !== "billing") router.replace("/welcome");
    });
  }, [load, router]);

  /**
   * Payment recorded. Re-ask the server rather than assuming: the gate is
   * the authority on whether they are back in, and if something about the
   * write did not take, sending them into a dashboard that will bounce
   * them straight back here is worse than staying put.
   */
  const handlePaid = useCallback(() => {
    toast.success("Payment received — welcome back.");
    load((next) => {
      if (next.step === "done") router.replace("/dashboard");
    });
  }, [load, router]);

  const { pay, pending } = useRazorpayCheckout({
    prefill: identity,
    onPaid: handlePaid,
  });

  const handleEnquiry = async (payload: EnquiryPayload) => {
    setEnquirySubmitting(true);
    try {
      await submitEnquiry(payload);
      toast.success("Thanks — we'll be in touch shortly.");
      setEnquiryOpen(false);
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Failed to send enquiry",
      );
    } finally {
      setEnquirySubmitting(false);
    }
  };

  const signOut = async () => {
    await createClient().auth.signOut();
    router.replace("/login");
  };

  if (!state) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-muted/40">
        {error ? (
          <div className="w-full max-w-md px-6">
            <AuthFormError message={error} />
          </div>
        ) : (
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        )}
      </div>
    );
  }

  const { subscription, workspace, viewer, owner } = state;
  const isCancelled = subscription?.status === "cancelled";
  const support = {
    workspaceName: workspace.name,
    planDisplayName: subscription?.planDisplayName ?? null,
    email: identity.email || owner.email,
  };
  const whatsappHref = trialExtensionWhatsApp(support);

  /**
   * Can we actually charge for the plan they are already on?
   *
   * Two ways the answer is no, and both must show sales instead of a
   * button that 400s:
   *   - Enterprise is quoted by a human, so there is no amount.
   *   - A NEGOTIATED PRIVATE PLAN (`ENTERPRISE_ACME` with a real price and
   *     `is_active = false`, the practice documented in the admin panel's
   *     README) is deliberately absent from the selectable catalogue, and
   *     the API's checkout allowlist does not include it either.
   *
   * So "is it in `state.plans`?" is the honest test — that list IS the set
   * of plans this product sells itself.
   */
  const isPayablePlan =
    subscription !== null &&
    !subscription.isEnquiryOnly &&
    subscription.priceMonthly > 0 &&
    state.plans.some(
      (plan) => plan.name === subscription.planName && !plan.isEnquiryOnly,
    );
  const canPayForCurrentPlan = viewer.isOwner && isPayablePlan;
  /** A plan we cannot charge for: the only honest route is a conversation. */
  const needsSales = subscription !== null && !isPayablePlan;
  const endedOn = formatDate(subscription?.trialEndsAt);

  return (
    <div className="min-h-svh bg-muted/40 px-4 py-10 md:py-16">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-3 text-center">
          <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-500">
            <AlertCircle className="size-6" />
          </span>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            {isCancelled
              ? "Your subscription has ended"
              : "Your free trial has ended"}
          </h1>
          <p className="text-balance text-muted-foreground">
            {isCancelled
              ? `${workspace.name} no longer has an active plan.`
              : endedOn
                ? `${workspace.name}'s free trial ended on ${endedOn}.`
                : `${workspace.name} has used its free trial.`}{" "}
            Nothing has been deleted — your contacts, conversations and
            automations are exactly where you left them.
          </p>
        </header>

        {error ? <AuthFormError message={error} /> : null}

        {viewer.isOwner ? (
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6">
            {canPayForCurrentPlan && subscription ? (
              <>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Continue on
                    </p>
                    <p className="font-heading text-xl font-semibold">
                      {subscription.planDisplayName}
                    </p>
                  </div>
                  <p className="text-2xl font-bold">
                    ₹{subscription.priceMonthly.toLocaleString()}
                    <span className="text-sm font-normal text-muted-foreground">
                      /month
                    </span>
                  </p>
                </div>

                <Button
                  className="h-11 w-full"
                  disabled={pending}
                  onClick={() => pay(subscription.planName, "monthly")}
                >
                  {pending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Opening checkout...
                    </>
                  ) : (
                    <>
                      Pay and continue
                      <ArrowRight className="size-4" />
                    </>
                  )}
                </Button>

                <button
                  type="button"
                  className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => setShowPlans((open) => !open)}
                >
                  {showPlans
                    ? "Hide other plans"
                    : "Or choose a different plan"}
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {needsSales
                    ? "Your plan is priced by our sales team, so there is nothing " +
                      "to pay for here. Talk to us and we'll get you running again."
                    : "Choose a plan to continue."}
                </p>
                <Button
                  className="h-11 w-full"
                  onClick={() =>
                    needsSales ? setEnquiryOpen(true) : setShowPlans(true)
                  }
                >
                  {needsSales ? "Talk to sales" : "See plans"}
                </Button>
              </>
            )}

            {showPlans ? (
              <PlanChoices
                plans={state.plans}
                currentPlan={subscription?.planName ?? null}
                pending={pending}
                onPay={(planName) => pay(planName, "monthly")}
                onEnquire={() => setEnquiryOpen(true)}
              />
            ) : null}
          </section>
        ) : (
          /**
           * A teammate cannot fix this, and pretending otherwise wastes
           * their time: `user_subscriptions` is keyed by
           * `accounts.owner_user_id`, so a payment made by anyone else
           * lands on a row nothing reads. Name the person who can.
           */
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6">
            <h2 className="font-heading text-lg font-semibold">
              Ask your workspace owner to renew
            </h2>
            <p className="text-sm text-muted-foreground">
              Only the owner of {workspace.name} can pay for a plan.
              {owner.name ? ` That's ${owner.name}` : ""}
              {owner.email ? (
                <>
                  {owner.name ? " — " : " "}
                  <a
                    className="font-medium text-foreground underline underline-offset-4"
                    href={`mailto:${owner.email}`}
                  >
                    {owner.email}
                  </a>
                </>
              ) : (
                ""
              )}
              .
            </p>
          </section>
        )}

        <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-6">
          <h2 className="font-heading text-base font-semibold">
            Need more time?
          </h2>
          <p className="text-sm text-muted-foreground">
            Message us and we can extend your trial. We usually reply the
            same working day.
          </p>
          {/* Anchors styled with `buttonVariants` rather than <Button>:
              this Button wraps base-ui's primitive, which renders a real
              <button> and has no asChild escape hatch. */}
          <div className="flex flex-wrap gap-3">
            <a
              className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
              href={trialExtensionMailto(support)}
            >
              <Mail className="size-4" />
              Email {SUPPORT_EMAIL}
            </a>
            {whatsappHref ? (
              <a
                className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MessageCircle className="size-4" />
                WhatsApp us
              </a>
            ) : null}
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-center gap-4 text-sm text-muted-foreground">
          <button
            type="button"
            className="underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => setEnquiryOpen(true)}
          >
            Talk to sales
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="underline-offset-4 hover:text-foreground hover:underline"
            onClick={signOut}
          >
            Sign out
          </button>
        </div>
      </div>

      <EnterpriseEnquiryDialog
        open={enquiryOpen}
        onOpenChange={setEnquiryOpen}
        defaultName={identity.name}
        defaultEmail={identity.email}
        companySize={workspace.teamSize}
        submitting={enquirySubmitting}
        onSubmit={handleEnquiry}
      />
    </div>
  );
}

/**
 * "18 August 2026", or null for a date we cannot make sense of.
 *
 * Locale-independent by design: `en-GB` rather than the visitor's locale,
 * because a bare numeric date is ambiguous across regions and this one is
 * the whole reason they are locked out.
 */
function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * The plan list, with NO trial badges anywhere.
 *
 * This is the whole reason it is not the wizard's `PlanStep`: on this
 * screen a trial is not on offer, and a card that says "15-day free trial"
 * next to a Pay button is the contradiction that started all of this.
 */
function PlanChoices({
  plans,
  currentPlan,
  pending,
  onPay,
  onEnquire,
}: {
  plans: OnboardingPlan[];
  currentPlan: string | null;
  pending: boolean;
  onPay: (planName: string) => void;
  onEnquire: () => void;
}) {
  return (
    <ul className="flex flex-col gap-3 border-t pt-4">
      {plans.map((plan) => {
        const isCurrent = plan.name === currentPlan;

        return (
          <li
            key={plan.name}
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4",
              isCurrent ? "border-primary/60 bg-primary/5" : "border-border",
            )}
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium">
                {plan.displayName}
                {isCurrent ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    <Check className="size-3" />
                    Your plan
                  </span>
                ) : null}
              </p>
              <p className="text-sm text-muted-foreground">
                {plan.isEnquiryOnly
                  ? "Custom pricing"
                  : `₹${plan.priceMonthly.toLocaleString()}/month · ${plan.maxContacts.toLocaleString()} contacts`}
              </p>
            </div>

            <Button
              size="sm"
              variant={isCurrent ? "default" : "outline"}
              disabled={pending}
              onClick={() =>
                plan.isEnquiryOnly ? onEnquire() : onPay(plan.name)
              }
            >
              {plan.isEnquiryOnly ? "Talk to sales" : "Pay"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
