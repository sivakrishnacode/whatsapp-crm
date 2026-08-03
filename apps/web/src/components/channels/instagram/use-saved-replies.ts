'use client';

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'ig:saved-replies';
const MAX_SAVED = 12;

/**
 * Starters, not defaults — they seed an empty list and are then fully
 * editable. Chosen to cover the three things a comment queue is
 * actually full of: price questions, "how do I buy", and thanks.
 */
const SEED_REPLIES: string[] = [
  'Thanks so much! 🙌',
  'DMing you the details now!',
  'Sent you a DM with the price list 💬',
  'Link is in our bio!',
];

/**
 * Canned replies for the comment queue.
 *
 * WHY BROWSER-LOCAL
 *   These are one agent's typing shortcuts. They change constantly
 *   while working a queue, and syncing them would mean a table, an
 *   endpoint and a permissions question for something whose whole value
 *   is being instant. If they later need to be shared across a team,
 *   that is the moment to move them server-side — not before.
 *
 * WHY A MODULE-LEVEL STORE RATHER THAN useState + useEffect
 *   localStorage is an external store, and every open comment card
 *   mounts this hook. Reading it into per-card state would give each
 *   card its own copy that silently diverges the moment one of them
 *   saves a reply, and would need a setState during an effect to hydrate.
 *   `useSyncExternalStore` gives every card the same snapshot, keeps the
 *   server render deterministic, and picks up changes from other tabs.
 */
let snapshot: string[] | null = null;
const listeners = new Set<() => void>();

function readStorage(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return SEED_REPLIES;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : SEED_REPLIES;
  } catch {
    // Corrupt JSON, or storage blocked (private mode, quota). Not worth
    // an error toast — the feature just falls back to the seeds.
    return SEED_REPLIES;
  }
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Another tab writing the key. `storage` does NOT fire in the tab
  // that made the change, which is why `write` notifies directly.
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

/**
 * Must return the SAME array reference until something actually
 * changes — returning a fresh one each call makes React re-render
 * forever.
 */
function getSnapshot(): string[] {
  snapshot ??= readStorage();
  return snapshot;
}

function getServerSnapshot(): string[] {
  return SEED_REPLIES;
}

function write(next: string[]) {
  snapshot = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the change still holds for this session.
  }
  emit();
}

export function useSavedReplies() {
  const replies = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  const add = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = getSnapshot();
    if (current.includes(trimmed)) return;
    write([trimmed, ...current].slice(0, MAX_SAVED));
  }, []);

  const remove = useCallback((text: string) => {
    write(getSnapshot().filter((reply) => reply !== text));
  }, []);

  return { replies, add, remove, isFull: replies.length >= MAX_SAVED };
}
