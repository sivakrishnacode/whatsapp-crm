'use client';

import { useEffect, useRef } from 'react';

/**
 * The frame↔host-page channel.
 *
 * The widget is split across two iframes and the loader script, none of
 * which share a JS context. `postMessage` is the only way they can talk,
 * and it is also the only place a hostile page could inject state into the
 * widget — so both directions are deliberately narrow and validated.
 */

export interface HostMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Send intent up to the loader.
 *
 * `parent.postMessage` with `'*'` as the target is safe *here* and only
 * here: these messages carry no data — `{type: 'open'}`, `{type: 'toggle'}`
 * — so there is nothing for a wrong recipient to learn. The host's origin
 * is not knowable from inside the frame without being told it, and taking
 * it from a query param would mean trusting a value an attacker sets.
 *
 * Nothing that carries conversation content ever goes over this channel.
 * The frame talks to the API directly; the host page is only ever told
 * "open", "close" and an unread count.
 */
export function postToHost(message: HostMessage): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage(message, '*');
}

/**
 * Receive messages from the loader.
 *
 * Accepts only messages whose source IS our parent frame. Without that
 * check, any page on the internet could open a hidden iframe of this
 * widget and drive it — and more importantly, so could any *other* frame
 * on the host page.
 *
 * The origin is deliberately NOT checked: the loader runs on the
 * customer's own origin, which differs per customer and is not knowable
 * here. The source check is what carries the weight, and it is sufficient
 * because only our real parent can be `window.parent`.
 */
export function useHostMessages(handler: (message: HostMessage) => void): void {
  // Ref so a re-rendering caller does not detach and reattach the listener
  // on every render, which would drop messages arriving in between.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window.parent) return;
      const data = event.data as HostMessage | null;
      if (!data || typeof data.type !== 'string') return;
      handlerRef.current(data);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
}
