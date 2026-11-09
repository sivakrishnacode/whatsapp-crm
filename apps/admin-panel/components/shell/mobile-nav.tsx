'use client';

import { Menu, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The rail as a drawer below `lg`. The handoff asks for a collapsible menu
 * with focus management and real tap targets, and for the sidebar never to
 * cover content it cannot be dismissed from.
 *
 * - Opening moves focus to the close button; closing returns it to the
 *   trigger, so a keyboard user is never stranded.
 * - Escape closes, a tap on the scrim closes, and following a link closes
 *   (the pathname changing is the signal — no per-link wiring needed).
 * - Tab is kept inside the drawer while it is open.
 * - The drawer is PORTALLED to <body>. It is rendered from inside the sticky
 *   header, whose `backdrop-filter` makes it the containing block for
 *   `position: fixed` descendants — without the portal the "full-screen"
 *   drawer is clipped to the header's 64px.
 */
export function MobileNav({
  brand,
  children,
}: {
  brand: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [shownFor, setShownFor] = useState(pathname);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Close on navigation — React's "adjust state when a prop changes" pattern
  // (set during render, guarded), not an effect: an effect would paint the
  // open drawer over the new page for one frame before closing it.
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    const triggerEl = trigger.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      triggerEl?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="mobile-rail"
        className="text-ink-2 hover:bg-surface-2 -ml-1 grid size-10 place-items-center rounded-lg lg:hidden"
      >
        <Menu aria-hidden className="size-5" />
        <span className="sr-only">Open navigation</span>
      </button>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-50 lg:hidden">
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                onClick={() => setOpen(false)}
                className="absolute inset-0 bg-black/45"
              />
              <div
                id="mobile-rail"
                ref={panel}
                role="dialog"
                aria-modal="true"
                aria-label="Navigation"
                className="rail bg-rail rail-scroll shadow-pop absolute inset-y-0 left-0 flex w-[min(300px,86vw)] flex-col overflow-y-auto"
              >
                <div className="flex items-center justify-between px-4 pt-4 pb-2">
                  {brand}
                  <button
                    ref={closeButton}
                    type="button"
                    onClick={() => setOpen(false)}
                    className="text-rail-ink hover:bg-rail-2 grid size-10 place-items-center rounded-lg"
                  >
                    <X aria-hidden className="size-5" />
                    <span className="sr-only">Close navigation</span>
                  </button>
                </div>
                <div className="px-3 pt-2 pb-6">{children}</div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
