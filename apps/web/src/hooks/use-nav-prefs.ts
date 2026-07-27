'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Device-scoped layout preferences for the dual sidebar: whether the
 * primary rail shows labels, and whether the second panel is open.
 *
 * Backed by `useSyncExternalStore` rather than `useState` + a
 * read-localStorage-on-mount effect. localStorage *is* an external store,
 * so this is what the hook is for, and it buys three things the effect
 * version didn't have:
 *
 *   - No hydration mismatch. `getServerSnapshot` hands React the default
 *     during SSR/hydration, then the client snapshot takes over — which is
 *     the sanctioned version of what the inbox's contact-panel effect does
 *     by hand.
 *   - No cascading render on every mount (the effect version set state
 *     unconditionally right after painting).
 *   - Cross-tab sync for free: the `storage` event is part of the
 *     subscription, so collapsing the rail in one tab updates the others.
 */

const RAIL_KEY = 'conceps:nav:rail-expanded';
const PANEL_KEY = 'conceps:nav:panel-open';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Same-tab writes need an explicit nudge — `storage` only fires cross-tab. */
function emit(): void {
  for (const l of listeners) l();
}

function subscribe(onChange: Listener): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) return stored === 'true';
  } catch {
    // localStorage throws in private-browsing / sandboxed contexts.
  }
  return fallback;
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Persistence is best-effort.
  }
}

/**
 * One persisted boolean. Snapshots are primitives, so React's identity
 * check is a value comparison and no caching layer is needed.
 */
function useStoredBool(key: string, fallback: boolean) {
  const value = useSyncExternalStore(
    subscribe,
    useCallback(() => readBool(key, fallback), [key, fallback]),
    useCallback(() => fallback, [fallback]),
  );

  const toggle = useCallback(() => {
    writeBool(key, !readBool(key, fallback));
    emit();
  }, [key, fallback]);

  return [value, toggle] as const;
}

export interface NavPrefs {
  /** Rail shows labels (`lg:w-56`) rather than icons only (`lg:w-14`). */
  railExpanded: boolean;
  toggleRail: () => void;
  /** Second sidebar is open (only meaningful on panel-bearing routes). */
  panelOpen: boolean;
  togglePanel: () => void;
}

export function useNavPrefs(): NavPrefs {
  const [railExpanded, toggleRail] = useStoredBool(RAIL_KEY, true);
  const [panelOpen, togglePanel] = useStoredBool(PANEL_KEY, true);
  return { railExpanded, toggleRail, panelOpen, togglePanel };
}
