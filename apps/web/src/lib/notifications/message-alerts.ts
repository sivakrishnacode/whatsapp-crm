/**
 * Alert policy for inbound messages — which events deserve a sound or a
 * desktop notification, and what the user has chosen to receive.
 *
 * Pure by design: the decisions are the part worth testing, while the
 * effects (Audio, Notification, realtime subscription) live in
 * `use-message-alerts.ts`.
 */

import type { Message } from '@/types';

export const ALERT_SOUND_URL = '/sounds/new-message.mp3';

/** localStorage keys. Namespaced so they read clearly in devtools. */
const SOUND_KEY = 'converse360.alerts.sound';
const DESKTOP_KEY = 'converse360.alerts.desktop';

/**
 * Minimum gap between sounds. A burst of ten messages should announce
 * itself once, not ten times — the point is "something arrived", and
 * overlapping playback of the same clip just sounds broken.
 */
export const SOUND_THROTTLE_MS = 3000;

/**
 * How recent an INSERT has to be to count as "new".
 *
 * Supabase realtime replays events after a dropped connection, so a
 * laptop waking from sleep can deliver a batch of inserts that are hours
 * old. Without this, closing the lid and reopening it plays the whistle
 * for yesterday's messages.
 */
export const FRESH_WINDOW_MS = 60_000;

export interface AlertPreferences {
  sound: boolean;
  desktop: boolean;
  permission: NotificationPermission | 'unsupported';
}

/**
 * Preferences are exposed as an external store rather than component
 * state, for three reasons:
 *
 *   - localStorage genuinely IS external state, so the read belongs in a
 *     snapshot rather than a state-setting effect.
 *   - `getServerSnapshot` gives SSR a defined answer without a hydration
 *     mismatch on the help text (which differs when permission is denied).
 *   - The `storage` event means muting in one tab mutes every tab, which
 *     is what a user expects from an app they keep open in several.
 */
const SERVER_SNAPSHOT: AlertPreferences = {
  sound: true,
  desktop: false,
  permission: 'unsupported',
};

// useSyncExternalStore compares snapshots by identity, so an object built
// fresh on every call would loop forever. Cache until something changes.
let cached: AlertPreferences = SERVER_SNAPSHOT;
let cacheKey = '';

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeAlertPreferences(onChange: () => void): () => void {
  listeners.add(onChange);
  // Cross-tab: `storage` fires in OTHER tabs only, which is exactly the
  // case local writes don't cover.
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function getAlertPreferencesSnapshot(): AlertPreferences {
  if (typeof window === 'undefined') return SERVER_SNAPSHOT;
  const sound = window.localStorage.getItem(SOUND_KEY) !== 'off';
  const desktop = window.localStorage.getItem(DESKTOP_KEY) === 'on';
  const permission =
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const key = `${String(sound)}|${String(desktop)}|${permission}`;
  if (key !== cacheKey) {
    cacheKey = key;
    cached = { sound, desktop, permission };
  }
  return cached;
}

export function getAlertPreferencesServerSnapshot(): AlertPreferences {
  return SERVER_SNAPSHOT;
}

/** Sound on by default; desktop off until the user grants permission. */
export function readAlertPreferences(): AlertPreferences {
  return getAlertPreferencesSnapshot();
}

export function writeAlertPreference(
  key: 'sound' | 'desktop',
  enabled: boolean,
): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    key === 'sound' ? SOUND_KEY : DESKTOP_KEY,
    enabled ? 'on' : 'off',
  );
  // `storage` does not fire in the tab that wrote, so tell this tab too.
  notify();
}

/** Re-read after `Notification.requestPermission` resolves. */
export function refreshAlertPermission(): void {
  notify();
}

/**
 * Should this message raise an alert at all?
 *
 * Only customer messages: an agent's own send and a bot's auto-reply both
 * land in the same table, and alerting on those would ping the person who
 * just caused them.
 */
export function isAlertableMessage(
  message: Pick<Message, 'sender_type' | 'created_at'>,
  now: number,
): boolean {
  if (message.sender_type !== 'customer') return false;
  const created = Date.parse(message.created_at);
  if (!Number.isFinite(created)) return false;
  // Tolerate small clock skew between the DB and the browser, but reject
  // anything meaningfully older than the window.
  return now - created < FRESH_WINDOW_MS;
}

/** Rate-limit gate for the sound. */
export function shouldPlaySound(lastPlayedAt: number, now: number): boolean {
  return now - lastPlayedAt >= SOUND_THROTTLE_MS;
}

/**
 * Is the user somewhere other than this app right now?
 *
 * Both signals are needed and neither is sufficient:
 *
 *   - `document.hidden` covers a background tab and a minimised window,
 *     but stays FALSE when our tab is still the active tab and the user
 *     has simply switched to another application. Alerting on hidden
 *     alone would stay silent in exactly the "I'm in another app" case
 *     this feature exists for.
 *   - `document.hasFocus()` covers that, but is also false when focus
 *     sits in devtools or the address bar — harmless, and it flips back
 *     the moment the page is clicked.
 *
 * Deliberately no "is the inbox open / is this the conversation on
 * screen" refinement: if the app is in front of you, you can see the
 * message arrive, and a sound is noise.
 */
export function isUserAway(hidden: boolean, hasFocus: boolean): boolean {
  return hidden || !hasFocus;
}

/** Short preview for the notification body, collapsed to one line. */
export function alertBody(message: Pick<Message, 'content_type' | 'content_text'>): string {
  const text = message.content_text?.replace(/\s+/g, ' ').trim();
  if (text) return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  switch (message.content_type) {
    case 'image':
      return 'Sent a photo';
    case 'video':
      return 'Sent a video';
    case 'audio':
      return 'Sent a voice note';
    case 'document':
      return 'Sent a document';
    case 'location':
      return 'Shared a location';
    default:
      return 'Sent a message';
  }
}
