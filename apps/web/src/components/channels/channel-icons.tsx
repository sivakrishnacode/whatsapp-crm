import { useId } from 'react';

/**
 * Brand glyphs for the channel rail.
 *
 * lucide-react 1.x dropped its brand icons, so WhatsApp, Instagram and
 * Facebook have to be hand-rolled. All three accept only `className` so
 * they're drop-in-compatible with the lucide icons used everywhere else
 * in the nav (see the `NavIcon` type in lib/nav/channels.ts).
 *
 * WhatsApp is a filled glyph in `currentColor`, so the rail's
 * `accentClass` tints it like any lucide icon. Instagram is drawn with a
 * real brand gradient, which `currentColor` can't express — it ignores
 * the accent class and paints itself.
 *
 * `settings-sections.ts` carries its own inline Facebook SVG rather than
 * importing the one below: its `SectionMeta.icon` is typed `LucideIcon`,
 * which demands a forwardRef taking every SVG prop, and this file's
 * `{ className }` contract deliberately promises less.
 */

export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38c1.45.79 3.08 1.21 4.79 1.21 5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2Zm0 18.15c-1.55 0-3.07-.42-4.4-1.2l-.32-.19-3.12.82.83-3.04-.2-.33a8.19 8.19 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.24-8.23 4.54 0 8.23 3.69 8.23 8.23 0 4.54-3.69 8.3-8 8.3Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.8-.23-.09-.39-.13-.56.12-.16.25-.64.8-.79.97-.14.16-.29.19-.54.06-.25-.12-1.06-.39-2.02-1.25-.75-.66-1.25-1.48-1.4-1.73-.14-.25-.01-.39.11-.51.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.35-.77-1.85-.2-.48-.41-.42-.56-.43h-.48c-.16 0-.43.06-.65.31-.23.25-.87.85-.87 2.07 0 1.23.89 2.41 1.01 2.58.12.16 1.75 2.79 4.25 3.81.59.26 1.06.41 1.42.52.6.19 1.14.16 1.57.1.48-.07 1.48-.6 1.69-1.19.21-.58.21-1.08.15-1.19-.06-.1-.23-.17-.48-.29Z" />
    </svg>
  );
}

export function InstagramIcon({ className }: { className?: string }) {
  // useId keeps the gradient id unique per instance — the rail, the panel
  // header, the connect screen and the onboarding card can all render
  // this at once, and duplicate SVG ids would collide.
  const gradientId = useId();
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="24" x2="24" y2="0">
          <stop offset="0%" stopColor="#FEDA75" />
          <stop offset="25%" stopColor="#FA7E1E" />
          <stop offset="50%" stopColor="#D62976" />
          <stop offset="75%" stopColor="#962FBF" />
          <stop offset="100%" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <g
        stroke={`url(#${gradientId})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="2" width="20" height="20" rx="5" />
        <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37Z" />
        <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
      </g>
    </svg>
  );
}

/**
 * Outline rather than filled, unlike WhatsApp above: this one is used at
 * label size next to lucide glyphs (the contact-source badge), where a
 * solid brand shape reads as heavier than everything around it.
 */
export function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  );
}
