'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Users } from 'lucide-react';

import { formatCompact, type AdType, type ReachEstimate } from '@/lib/ads/types';
import type { WizardState } from './wizard-state';

/**
 * Estimated audience size for the current targeting.
 *
 * The reference product shows a bare "Unable To Fetch" here. This shows
 * Meta's actual reason instead, because the estimate is the only feedback
 * a user gets that their targeting is sane before money is spent on it —
 * and "your targeting is too narrow" and "your ad account is too new" call
 * for completely different responses.
 *
 * Debounced hard (800ms) and only re-run when the targeting genuinely
 * changes: it is a live Graph call against a rate limit the whole
 * workspace shares, so firing on every keystroke would throttle the sync
 * job too.
 */
export function ReachEstimateCard({
  adType,
  optimizationGoal,
  state,
}: {
  adType: AdType | null;
  optimizationGoal: string;
  state: WizardState;
}) {
  const [estimate, setEstimate] = useState<ReachEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A fingerprint of only the fields that affect the estimate. Without it
  // this would re-run when the ad copy changed, which cannot possibly move
  // the number.
  const fingerprint = JSON.stringify({
    adType,
    optimizationGoal,
    locations: state.locations.map((l) => l.key),
    excluded: state.excludedLocations.map((l) => l.key),
    ageMin: state.ageMin,
    ageMax: state.ageMax,
    genders: state.genders,
    platforms: state.publisherPlatforms,
    fb: state.facebookPositions,
    ig: state.instagramPositions,
    interests: state.interests.map((i) => i.id),
    custom: state.customAudienceIds,
    excludedCustom: state.excludedCustomAudienceIds,
    saved: state.savedAudienceId,
    expansion: state.audienceExpansion,
  });

  useEffect(() => {
    if (!adType || !optimizationGoal) return;
    // Nothing to estimate before a location is chosen, and asking Meta
    // for "everyone on earth" is a wasted call.
    if (!state.savedAudienceId && state.locations.length === 0) {
      setEstimate(null);
      return;
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/ads/reach-estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            adType,
            optimizationGoal,
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
          }),
        });

        if (!res.ok) throw new Error('Request failed');
        setEstimate((await res.json()) as ReachEstimate);
      } catch {
        setEstimate({
          lowerBound: null,
          upperBound: null,
          unavailableReason: 'Could not reach Meta for an estimate.',
        });
      } finally {
        setLoading(false);
      }
    }, 800);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    /* `fingerprint` is the intentional dependency: it captures exactly the
       fields that change the estimate. Listing `state` would re-fire this
       Graph call on every keystroke in the ad copy, which cannot move the
       number. The disable must be the LAST line before the array or it
       attaches to a comment instead. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Users className="size-3.5" />
        Estimated audience
      </p>

      {loading ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Estimating…
        </p>
      ) : !estimate ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Add a location to see how many people this could reach.
        </p>
      ) : estimate.unavailableReason ? (
        <>
          <p className="mt-2 flex items-center gap-1.5 text-sm text-foreground">
            <RefreshCw className="size-3.5 text-muted-foreground" />
            Not available
          </p>
          {/* Meta's own reason, not a shrug. */}
          <p className="mt-1 text-xs text-muted-foreground">
            {estimate.unavailableReason}
          </p>
        </>
      ) : (
        <>
          <p className="mt-1.5 text-xl font-semibold tabular-nums text-foreground">
            {formatCompact(estimate.lowerBound)} –{' '}
            {formatCompact(estimate.upperBound)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            people per month, based on Meta&apos;s own estimate. It is a range
            because Meta will not report an exact figure, and it is not a
            promise of delivery.
          </p>
        </>
      )}
    </div>
  );
}
