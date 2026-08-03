'use client';

import { useCallback, useSyncExternalStore } from 'react';

export type PanelLayout = 'side' | 'center';

const STORAGE_KEY = 'ig:post-panel-layout';

/**
 * Side by default: it keeps the grid visible, so moving between posts
 * costs one click rather than close-then-open. Centre is the deliberate
 * choice for working one post hard.
 */
const DEFAULT_LAYOUT: PanelLayout = 'side';

/**
 * Where the post detail panel opens — docked right, or centred.
 *
 * A module-level store rather than component state so the choice
 * survives the panel unmounting between posts, and `useSyncExternalStore`
 * rather than `useState` + `useEffect` so the server render stays
 * deterministic and no state is set during an effect.
 */
let snapshot: PanelLayout | null = null;
const listeners = new Set<() => void>();

function readStorage(): PanelLayout {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'center'
      ? 'center'
      : DEFAULT_LAYOUT;
  } catch {
    // Storage blocked (private mode). Not worth surfacing — the panel
    // just opens in the default position.
    return DEFAULT_LAYOUT;
  }
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Another tab changing the preference. `storage` does NOT fire in the
  // tab that made the change, which is why `setLayout` notifies directly.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    snapshot = readStorage();
    emit();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('storage', onStorage);
  };
}

function getSnapshot(): PanelLayout {
  snapshot ??= readStorage();
  return snapshot;
}

function getServerSnapshot(): PanelLayout {
  return DEFAULT_LAYOUT;
}

export function usePanelLayout() {
  const layout = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  const setLayout = useCallback((next: PanelLayout) => {
    snapshot = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the change still holds for this session.
    }
    emit();
  }, []);

  return { layout, setLayout };
}
