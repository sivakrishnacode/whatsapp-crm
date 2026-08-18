"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { AuthFormError } from "@/components/auth/auth-shell";
import { WorkspaceStep } from "@/components/onboarding/workspace-step";
import { PlanStep } from "@/components/onboarding/plan-step";
import { EnterpriseEnquiryDialog } from "@/components/onboarding/enterprise-enquiry-dialog";
import {
  fetchOnboardingState,
  saveWorkspace,
  selectPlan,
  submitEnquiry,
  type EnquiryPayload,
  type OnboardingState,
  type WorkspacePayload,
} from "@/lib/onboarding/api";

/** Where a finished wizard hands over: the channel-connect checklist. */
const NEXT_AFTER_ONBOARDING = "/onboarding";

/**
 * Where a LAPSED account belongs instead of this wizard.
 *
 * `step === 'billing'` means the workspace has spent its one trial
 * (migration 074) and paid nothing. This screen cannot help it: every
 * button here asks the server to start a trial, and the server will
 * refuse. See app/(onboarding)/billing/page.tsx.
 */
const BILLING_LOCKED = "/billing";

const STEP_ORDER = ["workspace", "plan"] as const;

/**
 * The guided signup at `/welcome`.
 *
 * Two steps, both mandatory: name the workspace, then choose a plan.
 * The server owns which step is current (`state.step`) rather than this
 * component holding an index — reload, back button and a second tab all
 * then agree, and a half-finished wizard resumes where it stopped
 * instead of starting over.
 */
export default function WelcomePage() {
  const t = useTranslations("WelcomePage");
  const router = useRouter();

  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [enquiryOpen, setEnquiryOpen] = useState(false);
  const [identity, setIdentity] = useState({ name: "", email: "" });

  // Prefill the enquiry form from the session — whoever is filling it
  // in is already signed in, so asking for their name again is noise.
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

  // Promise callbacks rather than an awaited call in the effect body:
  // the state lands after the fetch settles, which is the "subscribe to
  // an external system" shape React expects, not a synchronous
  // set-state-during-effect.
  useEffect(() => {
    let active = true;

    fetchOnboardingState()
      .then((next) => {
        if (!active) return;
        setState(next);
        // Already finished — someone navigated back to /welcome by hand.
        if (next.step === "done") router.replace(NEXT_AFTER_ONBOARDING);
        else if (next.step === "billing") router.replace(BILLING_LOCKED);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      active = false;
    };
  }, [router]);

  /**
   * Every mutation returns the whole new state, so the wizard advances
   * on the server's word rather than by incrementing a local counter.
   */
  const apply = async (
    action: () => Promise<OnboardingState>,
  ): Promise<void> => {
    setError(null);
    try {
      const next = await action();
      setState(next);
      if (next.step === "done") router.replace(NEXT_AFTER_ONBOARDING);
      else if (next.step === "billing") router.replace(BILLING_LOCKED);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleWorkspace = async (payload: WorkspacePayload) => {
    setSubmitting(true);
    await apply(() => saveWorkspace(payload));
    setSubmitting(false);
  };

  const handlePlan = async (planName: string) => {
    setPendingPlan(planName);
    await apply(() => selectPlan(planName));
    setPendingPlan(null);
  };

  const handleEnquiry = async (payload: EnquiryPayload) => {
    setSubmitting(true);
    await apply(() => submitEnquiry(payload));
    setSubmitting(false);
    setEnquiryOpen(false);
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

  const isPlanStep = state.step === "plan";
  const trialDays = state.plans.find((plan) => plan.trialDays)?.trialDays ?? 15;
  // Same distinction as PlanStep: the plan offers a trial, the WORKSPACE
  // may already have used its only one.
  const planDesc = state.trialAvailable
    ? t("planDesc", { days: trialDays })
    : t("planDescNoTrial");

  return (
    <div className="min-h-svh bg-muted/40 px-4 py-10 md:py-16">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-8",
          // The plan cards need the room; the form reads better narrow.
          isPlanStep ? "max-w-5xl" : "max-w-2xl",
        )}
      >
        <StepIndicator current={state.step} />

        <div className="flex flex-col gap-2 text-center">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            {isPlanStep ? t("planTitle") : t("workspaceTitle")}
          </h1>
          <p className="text-muted-foreground text-balance">
            {isPlanStep ? planDesc : t("workspaceDesc")}
          </p>
        </div>

        {error ? <AuthFormError message={error} /> : null}

        {isPlanStep ? (
          <PlanStep
            plans={state.plans}
            trialAvailable={state.trialAvailable}
            pendingPlan={pendingPlan}
            onSelect={handlePlan}
            onEnquire={() => setEnquiryOpen(true)}
          />
        ) : (
          <div className="rounded-xl border border-border bg-card p-6 md:p-8">
            <WorkspaceStep
              initial={state.workspace}
              submitting={submitting}
              onSubmit={handleWorkspace}
            />
          </div>
        )}
      </div>

      <EnterpriseEnquiryDialog
        open={enquiryOpen}
        onOpenChange={setEnquiryOpen}
        defaultName={identity.name}
        defaultEmail={identity.email}
        companySize={state.workspace.teamSize}
        submitting={submitting}
        onSubmit={handleEnquiry}
      />
    </div>
  );
}

/** Two dots and a rule. Enough for a two-step wizard. */
function StepIndicator({ current }: { current: OnboardingState["step"] }) {
  const t = useTranslations("WelcomePage");
  const activeIndex = current === "workspace" ? 0 : 1;
  const labels = [t("workspaceStep"), t("planStep")];

  return (
    <div className="flex items-center justify-center gap-3">
      {STEP_ORDER.map((step, index) => {
        const isDone = index < activeIndex;
        const isActive = index === activeIndex;

        return (
          <div key={step} className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs font-semibold",
                  isDone && "bg-primary text-primary-foreground",
                  isActive && "bg-primary/10 text-primary ring-1 ring-primary",
                  !isDone && !isActive && "bg-muted text-muted-foreground",
                )}
              >
                {isDone ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-sm",
                  isActive
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {labels[index]}
              </span>
            </div>
            {index < STEP_ORDER.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "h-px w-8",
                  isDone ? "bg-primary" : "bg-border",
                )}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
