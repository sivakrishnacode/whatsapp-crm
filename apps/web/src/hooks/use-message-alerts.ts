'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Message } from '@/types';
import {
  alertBody,
  getAlertPreferencesServerSnapshot,
  getAlertPreferencesSnapshot,
  isAlertableMessage,
  isUserAway,
  refreshAlertPermission,
  shouldPlaySound,
  subscribeAlertPreferences,
  writeAlertPreference,
  ALERT_SOUND_URL,
} from '@/lib/notifications/message-alerts';

/**
 * Plays a sound (and optionally raises a desktop notification) when a
 * customer message arrives, wherever the user is in the app.
 *
 * WHAT WORKS WHERE — this is the part that trips people up:
 *
 *   - Another tab in this browser: yes. The realtime WebSocket keeps
 *     delivering and audio plays from a background tab.
 *   - Another app entirely, browser still running: yes, same reason.
 *   - Browser closed: NO. Nothing of ours is running. That needs Web
 *     Push with a service worker and a server-side subscription, which
 *     is a different feature.
 *
 * THE AUTOPLAY CATCH
 *   Browsers refuse `audio.play()` until the page has seen a real user
 *   gesture, and a refusal is a rejected promise, not an error you can
 *   see coming. So the clip is unlocked on the first pointer/key event:
 *   played muted and immediately paused, which satisfies the policy and
 *   leaves the element primed for later, gesture-free playback. Without
 *   this, the first message of a session is silent.
 *
 * BACKGROUND-TAB THROTTLING
 *   Timers are throttled in hidden tabs, so nothing here depends on one.
 *   The throttle between sounds is a timestamp comparison, not a
 *   setTimeout, for exactly that reason.
 */
export function useMessageAlerts() {
  // Preferences are an external store (localStorage). useSyncExternalStore
  // is the correct primitive: no hydration-mismatch risk (getServerSnapshot
  // returns a static default), no set-state-in-effect lint violation, and
  // cross-tab sync via the `storage` event comes for free.
  const prefs = useSyncExternalStore(
    subscribeAlertPreferences,
    getAlertPreferencesSnapshot,
    getAlertPreferencesServerSnapshot,
  );

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);
  const lastPlayedRef = useRef(0);
  // Read inside the realtime callback, which is registered once —
  // the snapshot would be captured stale there.
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  // Prime the clip on the first gesture anywhere in the page.
  useEffect(() => {
    const audio = new Audio(ALERT_SOUND_URL);
    audio.preload = 'auto';
    audioRef.current = audio;

    const unlock = () => {
      if (unlockedRef.current) return;
      unlockedRef.current = true;
      const previous = audio.volume;
      audio.volume = 0;
      audio
        .play()
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = previous;
        })
        .catch(() => {
          // Still blocked (or the file is missing). Leave it primed
          // anyway — a later gesture may succeed, and a failed alert
          // sound is not worth surfacing to the user.
          audio.volume = previous;
          unlockedRef.current = false;
        });
    };

    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      audio.pause();
      audioRef.current = null;
    };
  }, []);

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const now = Date.now();
    if (!shouldPlaySound(lastPlayedRef.current, now)) return;
    lastPlayedRef.current = now;
    // Rewind: replaying a clip that already finished is a no-op otherwise.
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
  }, []);

  useEffect(() => {
    const supabase = createClient();

    // Its own channel, matching the convention of use-total-unread — a
    // shared channel would couple unrelated subscribers' lifecycles.
    const channel = supabase
      .channel('message-alerts-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const message = payload.new as Message;
          if (!isAlertableMessage(message, Date.now())) return;

          const current = prefsRef.current;
          const away = isUserAway(document.hidden, document.hasFocus());

          // Only alert when the user isn't looking at the app —
          // a ringtone while you're reading the inbox is just noise.
          if (current.sound && away) play();

          if (
            current.desktop &&
            away &&
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted'
          ) {
            try {
              const notification = new Notification('New WhatsApp message', {
                body: alertBody(message),
                // Same tag for every message: a stack of twenty popups is
                // worse than one that updates.
                tag: 'converse360-new-message',
                // src/app/icon.tsx renders the brand mark as a PNG at
                // this route; notification icons want a raster, and SVG
                // support across browsers is patchy.
                icon: '/icon',
              });
              notification.onclick = () => {
                window.focus();
                notification.close();
              };
            } catch {
              // Some browsers throw for constructor-based notifications
              // and want the service-worker API instead. Sound already
              // fired, so degrade quietly.
            }
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [play]);

  const setSound = useCallback((enabled: boolean) => {
    writeAlertPreference('sound', enabled);
  }, []);

  /**
   * Turning desktop alerts on requires permission, and the request must
   * happen inside a user gesture — hence a callback the UI calls from a
   * click rather than an effect that asks on load.
   */
  const setDesktop = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      writeAlertPreference('desktop', false);
      return;
    }
    if (typeof Notification === 'undefined') return;
    let granted = Notification.permission;
    if (granted === 'default') granted = await Notification.requestPermission();
    if (granted === 'granted') {
      writeAlertPreference('desktop', true);
    }
    // Refresh the snapshot so the UI reflects the new permission state
    refreshAlertPermission();
  }, []);

  return {
    ...prefs,
    setSound,
    setDesktop,
    /** Play the clip on demand, for a "test sound" control. */
    preview: play,
  };
}
