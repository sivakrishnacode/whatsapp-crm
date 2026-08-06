'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { emptyWizardState, type WizardState } from './wizard-state';
import type { AdType } from '@/lib/ads/types';

/**
 * Keeps a half-built ad alive across a refresh, and the ad type + step in
 * the URL.
 *
 * WHY THE DRAFT IS NOT IN THE URL, THOUGH THE PLAN SAID "STATE IN THE URL"
 *   The intent was "a refresh must not lose the work". Encoding the whole
 *   draft would technically do that and be worse in every other way: the
 *   state includes location lists, interest lists, placement arrays and
 *   creative copy, which is multiple kilobytes of base64 in the address
 *   bar. It would blow past what some proxies and server logs accept, and
 *   it would not even make the URL shareable — `imageHash` and audience ids
 *   are scoped to one ad account, so a colleague opening the link would get
 *   a draft referencing assets they cannot see.
 *
 *   So the two kinds of state are split by what they are for:
 *     * `?type=` and `?step=` in the URL — navigation. Deep-linkable, and
 *       the back button steps backwards through the wizard, which is what
 *       people expect a back button to do.
 *     * the draft in `sessionStorage` — recovery. Survives a refresh and an
 *       accidental navigation away, and dies with the tab.
 *
 *   `sessionStorage`, not `localStorage`: a draft that reappears a week
 *   later, referencing an image that has since been deleted, is a bug that
 *   presents as haunted software.
 */

const DRAFT_KEY = 'ads-wizard-draft';

/** Bumped when `WizardState` changes shape, so an old draft is discarded. */
const DRAFT_VERSION = 1;

interface StoredDraft {
  version: number;
  state: WizardState;
}

export interface WizardPersistence {
  state: WizardState;
  patch: (next: Partial<WizardState>) => void;
  step: number;
  setStep: (step: number) => void;
  /** True once the stored draft has been read — render nothing before it. */
  ready: boolean;
  clear: () => void;
}

export function useWizardPersistence(): WizardPersistence {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [state, setState] = useState<WizardState>(emptyWizardState);
  const [ready, setReady] = useState(false);

  const urlType = searchParams.get('type');
  const urlStep = Number(searchParams.get('step') ?? '1');
  // 0 is valid and means "every accordion section collapsed" — the wizard
  // toggles the open section shut by setting it. Clamping 0 up to 1 would
  // make collapsing the open step jump to step 1 instead.
  const step =
    Number.isInteger(urlStep) && urlStep >= 0 && urlStep <= 4 ? urlStep : 1;

  /**
   * Restore the draft once, after mount.
   *
   * WHY AN EFFECT, AND NOT `useSyncExternalStore` LIKE use-nav-prefs.ts
   *   That hook is the right tool for a read-mostly *preference* backed by
   *   storage — it gives a snapshot React re-reads when the store changes.
   *   This is the opposite shape: the draft is read ONCE and then owned and
   *   mutated by the component for the rest of its life. Modelling mutable
   *   working state as an external store would mean writing to storage on
   *   every keystroke just to read it back, and cross-tab sync — the main
   *   thing that hook buys — would actively fight the user by overwriting
   *   the form they are typing into from another tab.
   *
   *   A lazy `useState` initializer is also wrong: it runs during render,
   *   including on the server where `sessionStorage` does not exist, and on
   *   the client it would make the first render disagree with the server's
   *   HTML. Reading after mount is the hydration-safe option.
   */
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredDraft;
        if (parsed.version === DRAFT_VERSION && parsed.state) {
          // Merged over the defaults rather than used directly: a draft
          // written before a field existed would otherwise leave it
          // `undefined` and crash a `.length` somewhere downstream.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setState({ ...emptyWizardState, ...parsed.state });
        }
      }
    } catch {
      // Corrupt or unavailable (private mode, quota). Losing a draft is
      // recoverable; failing to render the wizard is not.
    }
    setReady(true);
  }, []);

  /**
   * The ad type is DERIVED, not stored twice.
   *
   * `?type=` wins when present, so a shared link or a back navigation
   * selects the right card; otherwise the restored draft's own value is
   * used, so refreshing without a `?type=` in the URL does not wipe the
   * chosen type.
   *
   * Deriving rather than syncing the URL into state with an effect matters:
   * that effect would write state during render-commit on every navigation
   * (cascading renders, and `react-hooks/set-state-in-effect` rightly flags
   * it), and it would give two sources of truth that can disagree for one
   * frame.
   */
  const adType = ((urlType as AdType | null) ?? state.adType) as AdType | null;

  // Persist on change, debounced. Every keystroke in the ad copy would
  // otherwise be a synchronous JSON.stringify of the whole draft plus a
  // storage write.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!ready) return;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        // `mediaPreviewUrl` is nulled rather than persisted: for an
        // uploaded file it is an `object:` URL bound to this page's
        // lifetime, so restoring it after a refresh yields a broken image.
        // The `imageHash` survives, which is what matters for publishing.
        sessionStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({
            version: DRAFT_VERSION,
            state: { ...state, mediaPreviewUrl: null },
          } satisfies StoredDraft),
        );
      } catch {
        // Quota or private mode — the wizard still works, it just will not
        // survive a refresh.
      }
    }, 400);

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state, ready]);

  /**
   * Apply a partial update.
   *
   * `adType` is routed to the URL rather than into state, because that is
   * where it is read from — writing it to both would recreate the two-
   * sources-of-truth problem the derivation above exists to avoid. Every
   * other field goes to state as usual, in the same call, so choosing a type
   * (which also resets the goal and CTA) stays one atomic update.
   */
  const patch = useCallback(
    (next: Partial<WizardState>) => {
      const { adType: nextType, ...rest } = next;

      if (Object.keys(rest).length > 0) {
        setState((prev) => ({ ...prev, ...rest }));
      }

      if (nextType && nextType !== adType) {
        const params = new URLSearchParams(searchParams.toString());
        params.set('type', nextType);
        // `replace`, not `push`: picking a different card on step 1 is a
        // correction, not a navigation step, so Back should not walk through
        // every type the user considered.
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }
    },
    [adType, router, pathname, searchParams],
  );

  /**
   * Navigate to a step, and reflect the ad type.
   *
   * `push`, not `replace`, so the back button walks back through the steps.
   * `scroll: false` because the accordion keeps the heading in view and a
   * jump to the top on every Next press is disorienting.
   */
  const setStep = useCallback(
    (nextStep: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('step', String(nextStep));
      if (adType) params.set('type', adType);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams, adType],
  );

  const clear = useCallback(() => {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Nothing to do — the draft is already unreachable.
    }
    setState(emptyWizardState);
  }, []);

  // The derived ad type is merged in on the way out, so consumers see one
  // coherent state object and never need to know it came from the URL.
  return { state: { ...state, adType }, patch, step, setStep, ready, clear };
}
