'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Loader2,
  Lock,
  Rocket,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import {
  formatMinor,
  toMinorUnits,
  type AdType,
  type AdTypeCatalogue,
  type AdTypeInfo,
  type AdsSetupStatus,
} from '@/lib/ads/types';
import { AdPreview } from './ad-preview';
import { ReachEstimateCard } from './reach-estimate';
import { DestinationStep } from './destination-step';
import { TargetingStep } from './targeting-step';
import { BudgetStep } from './budget-step';
import { CreativeStep } from './creative-step';
import { validateStep, type WizardState } from './wizard-state';
import { useWizardPersistence } from './use-wizard-persistence';

/**
 * The Create Ad wizard.
 *
 * Four accordion steps on the left, a sticky preview and reach estimate on
 * the right — the shape the reference product uses, and a good one: the
 * preview is the only feedback on copy length, and the reach estimate the
 * only feedback on whether the targeting is sane.
 *
 * WHY THE STEP CATALOGUE COMES FROM THE API
 *   `/api/ads/ad-types` is generated from the same builder registry that
 *   validates a publish. So the objective, the performance-goal dropdown,
 *   the call-to-action list and the "this type is unavailable because…"
 *   copy are all the server's answers, not a second copy maintained here.
 *   A wizard that offered a goal the builder rejects would fail after four
 *   Graph calls, with the campaign already created.
 *
 * ⚠️ MONEY
 *   The budget input is in MAJOR units because that is what a human types.
 *   `toMinorUnits` converts once, at submit, and the API takes only
 *   `amountMinor` as an integer — so a mistake here cannot become a 100×
 *   overspend silently.
 */
export function AdWizard() {
  const router = useRouter();
  const canPublish = useCan('edit-settings');

  const [catalogue, setCatalogue] = useState<AdTypeCatalogue | null>(null);
  const [setup, setSetup] = useState<AdsSetupStatus | null>(null);
  const [publishing, setPublishing] = useState(false);

  // The draft lives in sessionStorage and the ad type + step live in the
  // URL, so a refresh keeps the work and the back button steps backwards.
  // See use-wizard-persistence.ts for why the whole draft is NOT in the URL.
  const {
    state,
    patch,
    step: openStep,
    setStep: setOpenStep,
    ready,
    clear,
  } = useWizardPersistence();

  useEffect(() => {
    void (async () => {
      try {
        const [typesRes, statusRes] = await Promise.all([
          fetch('/api/ads/ad-types', { cache: 'no-store' }),
          fetch('/api/ads/status', { cache: 'no-store' }),
        ]);
        if (typesRes.ok) {
          setCatalogue((await typesRes.json()) as AdTypeCatalogue);
        }
        if (statusRes.ok) {
          setSetup((await statusRes.json()) as AdsSetupStatus);
        }
      } catch {
        toast.error('Could not load the ad builder.');
      }
    })();
  }, []);

  const selectedType: AdTypeInfo | null = useMemo(
    () =>
      catalogue?.adTypes.find((t) => t.id === state.adType) ?? null,
    [catalogue, state.adType],
  );

  const currency = setup?.adAccount?.currency ?? null;

  // Per-step validity, derived rather than stored: a "step 2 is valid"
  // flag would go stale the moment a field on step 2 changed.
  const stepErrors = useMemo(
    () => ({
      1: validateStep(1, state, selectedType),
      2: validateStep(2, state, selectedType),
      3: validateStep(3, state, selectedType, setup),
      4: validateStep(4, state, selectedType),
    }),
    [state, selectedType, setup],
  );

  const firstInvalidStep = ([1, 2, 3, 4] as const).find(
    (step) => stepErrors[step].length > 0,
  );

  /**
   * Ask Meta for its own rendering of the current creative.
   *
   * Sends the same payload as a publish — the endpoint's DTO extends the
   * publish DTO, so a preview cannot succeed on input the publish would
   * reject.
   */
  const requestRealPreview = useCallback(async (): Promise<{
    url: string | null;
    unavailableReason: string | null;
  }> => {
    const res = await fetch('/api/ads/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPublishPayload(state)),
    });

    if (!res.ok) {
      return {
        url: null,
        unavailableReason: 'Meta could not generate a preview for this ad.',
      };
    }

    return (await res.json()) as {
      url: string | null;
      unavailableReason: string | null;
    };
  }, [state]);

  async function publish() {
    if (!selectedType) return;

    if (firstInvalidStep) {
      setOpenStep(firstInvalidStep);
      toast.error(stepErrors[firstInvalidStep][0]);
      return;
    }

    setPublishing(true);
    try {
      const res = await fetch('/api/ads/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPublishPayload(state)),
      });

      const body = (await res.json().catch(() => null)) as
        | {
            message?: string | string[];
            localCampaignId?: string;
            leftPaused?: boolean;
            warnings?: string[];
          }
        | null;

      if (!res.ok) {
        const message = Array.isArray(body?.message)
          ? body.message.join(', ')
          : body?.message;
        throw new Error(message ?? 'Meta rejected the ad.');
      }

      // A publish that could not be switched on is still a success — the
      // objects exist and are saved. Say so plainly rather than showing a
      // green toast that implies the ad is live.
      if (body?.leftPaused) {
        toast.warning(
          body.warnings?.[0] ??
            'The ad was created but could not be switched on. It is saved and paused.',
        );
      } else {
        toast.success(
          body?.warnings?.[0] ?? 'Ad published. It is now with Meta for review.',
        );
      }

      // Drop the draft: without this, opening Create Ad again would reopen
      // the ad that was just published.
      clear();
      router.push('/ads');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not publish');
    } finally {
      setPublishing(false);
    }
  }

  if (!catalogue || !ready) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading the ad builder…
      </div>
    );
  }

  // Not ready → say what is missing rather than letting them fill in four
  // steps and fail at Publish.
  if (setup && !setup.canPublish) {
    return <SetupRequired status={setup} />;
  }

  const steps = [
    {
      n: 1,
      title: 'Where should people go after clicking your ad?',
      subtitle:
        'This choice determines the campaign setup and the results you can optimise for.',
      body: (
        <DestinationStep
          catalogue={catalogue}
          state={state}
          patch={patch}
          selectedType={selectedType}
        />
      ),
    },
    {
      n: 2,
      title: 'Ad targeting & audience',
      subtitle:
        'Choose where your ad runs and who sees it.',
      body: <TargetingStep state={state} patch={patch} />,
    },
    {
      n: 3,
      title: 'Ad budget',
      subtitle:
        'Set how much to spend per day, and for how long the ad runs.',
      body: (
        <BudgetStep
          state={state}
          patch={patch}
          currency={currency}
          maxDailyBudgetMinor={setup?.maxDailyBudgetMinor ?? null}
        />
      ),
    },
    {
      n: 4,
      title: 'Ad creative',
      subtitle: 'The copy, media and button people see.',
      body: (
        <CreativeStep
          state={state}
          patch={patch}
          selectedType={selectedType}
          pixelEvents={catalogue.pixelEvents}
          pixelSelected={catalogue.pixelSelected}
        />
      ),
    },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-3">
        {steps.map((step) => {
          const errors = stepErrors[step.n as 1 | 2 | 3 | 4];
          const complete = errors.length === 0;
          const open = openStep === step.n;

          return (
            <section
              key={step.n}
              className={cn(
                'rounded-xl border bg-card transition-colors',
                open ? 'border-primary/40' : 'border-border',
              )}
            >
              <button
                type="button"
                onClick={() => setOpenStep(open ? 0 : step.n)}
                className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
                aria-expanded={open}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold',
                    complete
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border text-muted-foreground',
                  )}
                >
                  {complete ? <Check className="size-3.5" /> : step.n}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-foreground">
                    {step.title}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {step.subtitle}
                  </span>
                </span>
                <ChevronRight
                  className={cn(
                    'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
                    open && 'rotate-90',
                  )}
                />
              </button>

              {open ? (
                <div className="border-t border-border px-4 py-4">
                  {step.body}

                  {errors.length > 0 ? (
                    <ul className="mt-4 space-y-1">
                      {errors.map((error) => (
                        <li
                          key={error}
                          className="flex items-start gap-1.5 text-xs text-accent-amber"
                        >
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          {error}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {step.n < 4 ? (
                    <div className="mt-4 flex justify-end">
                      <Button
                        size="sm"
                        onClick={() => setOpenStep(step.n + 1)}
                        disabled={!complete}
                      >
                        Next
                        <ChevronRight className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {setup?.sandbox
              ? 'Sandbox mode — publishing will not send anything to Meta.'
              : `Spend is billed to you by Meta${
                  setup?.adAccount?.name
                    ? ` on ${setup.adAccount.name}`
                    : ''
                }, not through this app.`}
          </p>
          <Button
            onClick={() => void publish()}
            disabled={publishing || !canPublish || Boolean(firstInvalidStep)}
            title={
              !canPublish
                ? 'Only an admin or the workspace owner can publish an ad'
                : undefined
            }
          >
            {publishing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : !canPublish ? (
              <Lock className="size-4" />
            ) : (
              <Rocket className="size-4" />
            )}
            Publish
          </Button>
        </div>
      </div>

      {/* Sticky rail: the preview and the estimate are feedback on what is
          being typed, so they must stay in view while typing. */}
      <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <AdPreview
          adType={(state.adType ?? 'click_to_whatsapp') as AdType}
          pageName={setup?.page?.name ?? null}
          primaryText={state.primaryText}
          headline={state.headline}
          description={state.description}
          callToActionLabel={
            selectedType?.callToActions.find(
              (c) => c.value === state.callToAction,
            )?.label ?? null
          }
          imageUrl={state.mediaPreviewUrl}
          link={state.link || null}
          // Offered only once the payload would actually build. Meta rejects
          // an incomplete creative, and a preview button that always errors
          // is worse than no button.
          onRequestRealPreview={
            !firstInvalidStep ? requestRealPreview : undefined
          }
        />

        <ReachEstimateCard
          adType={state.adType}
          optimizationGoal={state.optimizationGoal}
          state={state}
        />

        {state.budgetAmount && currency ? (
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">
              {state.budgetMode === 'daily' ? 'Daily budget' : 'Total budget'}
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {formatMinor(toMinorUnits(state.budgetAmount), currency)}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SetupRequired({ status }: { status: AdsSetupStatus }) {
  const blocked = status.steps.filter((s) => !s.done);
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-8 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        Finish setup before creating an ad
      </h1>
      <ul className="mx-auto mt-4 max-w-sm space-y-2 text-left text-sm">
        {blocked.map((step) => (
          <li key={step.id}>
            <span className="text-foreground">{step.label}</span>
            {step.blocked ? (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {step.blocked}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <Button
        className="mt-6"
        nativeButton={false}
        render={<Link href="/ads/setup" />}
      >
        Go to setup
      </Button>
    </div>
  );
}

/**
 * The publish payload, built from the wizard state.
 *
 * Shared by Publish and by the real-preview request, deliberately: the
 * preview endpoint's DTO extends the publish DTO, so if these two ever
 * built different shapes a preview could succeed on input the publish would
 * reject — which is exactly the surprise a preview exists to prevent.
 */
function buildPublishPayload(state: WizardState) {
  return {
    adType: state.adType,
    campaignName: state.campaignName.trim(),
    specialAdCategories: state.specialAdCategories,
    optimizationGoal: state.optimizationGoal,
    budget: {
      mode: state.budgetMode,
      // The single conversion point. Everything downstream is minor
      // units, all the way to Graph.
      amountMinor: toMinorUnits(state.budgetAmount),
      startTime: state.startDate
        ? new Date(`${state.startDate}T00:00:00`).toISOString()
        : undefined,
      endTime: state.endDate
        ? new Date(`${state.endDate}T23:59:59`).toISOString()
        : undefined,
      schedule: state.scheduleBlocks.length
        ? state.scheduleBlocks
        : undefined,
    },
    targeting: {
      locations: state.locations.map((l) => ({
        key: l.key,
        type: l.type,
      })),
      excludedLocations: state.excludedLocations.map((l) => ({
        key: l.key,
        type: l.type,
      })),
      ageMin: state.ageMin,
      ageMax: state.ageMax,
      genders: state.genders,
      publisherPlatforms: state.publisherPlatforms,
      facebookPositions: state.facebookPositions,
      instagramPositions: state.instagramPositions,
      interests: state.interests.map((i) => ({
        id: i.id,
        category: i.category,
        name: i.name,
      })),
      customAudienceIds: state.customAudienceIds,
      excludedCustomAudienceIds: state.excludedCustomAudienceIds,
      savedAudienceId: state.savedAudienceId || undefined,
      audienceExpansion: state.audienceExpansion,
    },
    creative: {
      adName: state.adName.trim() || state.campaignName.trim(),
      primaryText: state.primaryText,
      headline: state.headline || undefined,
      description: state.description || undefined,
      callToAction: state.callToAction || undefined,
      imageHash: state.imageHash || undefined,
      videoId: state.videoId || undefined,
      videoThumbnailUrl: state.videoThumbnailUrl || undefined,
      link: state.link || undefined,
      whatsappWelcomeMessage: state.whatsappWelcomeMessage || undefined,
      leadFormId: state.leadFormId || undefined,
      conversionEvent: state.conversionEvent || undefined,
    },
  };
}
