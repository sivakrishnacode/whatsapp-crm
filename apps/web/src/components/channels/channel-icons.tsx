import { cn } from '@/lib/utils';

/**
 * Brand marks for the channel rail.
 *
 * lucide-react 1.x dropped its brand icons, so WhatsApp, Instagram and
 * Facebook have to come from here. All three accept only `className` so
 * they're drop-in-compatible with the lucide icons used everywhere else
 * in the nav (see the `NavIcon` type in lib/nav/channels.ts) — that
 * narrow contract is what lets WhatsApp and Instagram switch from
 * hand-drawn SVG to the official artwork without touching any of the
 * eight call sites.
 *
 * ⚠️ WHATSAPP AND INSTAGRAM ARE NOW RASTER, AND THEREFORE UNTINTABLE.
 * They render the official logos from /public/icons at whatever size
 * `className` asks for. Two consequences that look like bugs if you
 * don't know to expect them:
 *
 *   1. `accentClass` (and any other text-colour class) is a NO-OP on
 *      them. The rail still passes it; it does nothing here and is
 *      harmless, but don't add a colour class expecting a tint.
 *   2. They cannot sit on a same-coloured background. A brand tile
 *      inside a brand-coloured square is invisible — which is why the
 *      analytics header and the connect CTA render the mark on the card
 *      surface rather than in the tinted square they used to use.
 *
 * Opacity still works, so the rail's dimmed "coming soon" state and the
 * disabled treatments are unaffected.
 *
 * Facebook stays a `currentColor` outline: it is only ever used at label
 * size next to lucide glyphs (the contact-source badge), where a solid
 * brand shape reads heavier than everything around it.
 *
 * `settings-sections.ts` carries its own inline Facebook SVG rather than
 * importing the one below: its `SectionMeta.icon` is typed `LucideIcon`,
 * which demands a forwardRef taking every SVG prop, and this file's
 * `{ className }` contract deliberately promises less.
 */

/**
 * Shared renderer for the two raster marks.
 *
 * A plain `<img>` rather than `next/image`: these are local PNGs served
 * straight from /public at 16–56px, so the optimizer round trip buys
 * nothing, and `next/image` wants explicit dimensions that would fight
 * the `size-*` class each call site passes. Same call the Shopify/Woo
 * cards and `AppIcon` already make.
 *
 * `aria-hidden` with an empty alt keeps the semantics the SVGs had:
 * every call site pairs the mark with a visible text label, so
 * announcing it again would just be an echo.
 */
function BrandMark({ src, className }: { src: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden
      decoding="async"
      // object-contain, not cover: call sites pass `size-4`, `size-14`
      // and `h-5 w-5`, and a non-square box must letterbox the logo
      // rather than crop its rounded corners off.
      className={cn('shrink-0 object-contain', className)}
    />
  );
}

export function WhatsAppIcon({ className }: { className?: string }) {
  return <BrandMark src="/icons/whatsapp.png" className={className} />;
}

export function InstagramIcon({ className }: { className?: string }) {
  return <BrandMark src="/icons/instagram.png" className={className} />;
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
