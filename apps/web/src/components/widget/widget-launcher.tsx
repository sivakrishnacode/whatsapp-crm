'use client';

import { useEffect, useState } from 'react';
import { MessageCircle, X } from 'lucide-react';

import { postToHost, useHostMessages } from './widget-host-bridge';

/**
 * The launcher bubble — rendered in its own tiny iframe.
 *
 * WHY A SEPARATE FRAME FROM THE PANEL
 *   The launcher is visible on every page of the customer's site, all the
 *   time. If it were real DOM in the host page it would be exposed to
 *   their CSS reset, their `button {}` rules and their z-index stack; if it
 *   were part of the panel frame, that frame would have to stay
 *   panel-sized and transparent, so an invisible 400×620 rectangle would
 *   sit over their page swallowing clicks. A 56×56 frame swallows nothing.
 *
 * IT OWNS NO STATE OF ITS OWN
 *   Open/closed lives in the loader, because only the host page can resize
 *   and reposition the frames. This component renders what it is told and
 *   posts intent back — so there is one source of truth and the two frames
 *   cannot disagree about whether the chat is open.
 */
export function WidgetLauncher({
  accent,
  teaser,
  teaserDelaySeconds,
}: {
  accent: string;
  teaser: string | null;
  teaserDelaySeconds: number;
}) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [showTeaser, setShowTeaser] = useState(false);
  const [teaserDismissed, setTeaserDismissed] = useState(false);

  useHostMessages((message) => {
    if (message.type === 'state') setOpen(Boolean(message.open));
    else if (message.type === 'unread') setUnread(Number(message.count) || 0);
  });

  useEffect(() => {
    if (!teaser || teaserDismissed || open) return;
    const timer = window.setTimeout(
      () => setShowTeaser(true),
      Math.max(0, teaserDelaySeconds) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [teaser, teaserDelaySeconds, teaserDismissed, open]);

  // Opening the chat retires the teaser permanently — re-showing it to
  // someone already in a conversation is noise.
  useEffect(() => {
    if (open) {
      setShowTeaser(false);
      setTeaserDismissed(true);
    }
  }, [open]);

  // Force iframe html & body background to transparent, overriding Tailwind's bg-background
  useEffect(() => {
    const forceTransparent = () => {
      document.documentElement.style.setProperty('background', 'transparent', 'important');
      document.documentElement.style.setProperty('background-color', 'transparent', 'important');
      document.body.style.setProperty('background', 'transparent', 'important');
      document.body.style.setProperty('background-color', 'transparent', 'important');
      document.body.classList.remove('bg-background');
      document.body.classList.add('bg-transparent');
    };
    forceTransparent();
    const timer = setInterval(forceTransparent, 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        margin: 0,
        padding: 0,
        boxSizing: 'border-box',
      }}
    >
      {showTeaser && teaser && (
        <button
          type="button"
          onClick={() => postToHost({ type: 'open' })}
          className="absolute bottom-16 right-0 max-w-[240px] rounded-xl bg-white px-3.5 py-2.5 text-left text-xs leading-snug text-slate-800 shadow-xl border border-slate-100"
          style={{
            outline: 'none',
            boxSizing: 'border-box',
          }}
        >
          {teaser}
        </button>
      )}

      <button
        type="button"
        onClick={() => postToHost({ type: 'toggle' })}
        aria-label={open ? 'Close chat' : 'Open chat'}
        className="relative flex h-14 w-14 items-center justify-center rounded-full bg-white text-slate-900 shadow-xl transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer border border-slate-100/80 outline-none p-0 focus:outline-none"
        style={{
          width: '56px',
          height: '56px',
          borderRadius: '9999px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: 0,
          padding: 0,
          border: 'none',
          outline: 'none',
          boxSizing: 'border-box',
          backgroundColor: open ? accent : '#ffffff',
          color: open ? '#ffffff' : '#0f172a',
        }}
      >
        {open ? (
          <X className="h-5 w-5 text-white" />
        ) : (
          <svg width="26" height="26" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M14 2C7.37 2 2 7.04 2 13.26C2 16.03 3.12 18.57 5 20.48V25L9.12 23.36C10.63 24.13 12.28 24.52 14 24.52C20.63 24.52 26 19.48 26 13.26C26 7.04 20.63 2 14 2Z"
              fill={accent || '#0C1410'}
            />
            <path
              d="M9.5 13.5C9.5 15.43 11.51 17 14 17C16.49 17 18.5 15.43 18.5 13.5"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        )}

        {!open && unread > 0 && (
          <span
            className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white shadow-md ring-2 ring-white z-10"
            style={{
              margin: 0,
              padding: '0 4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
            }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    </div>
  );
}
