import type { ReactNode } from "react";
import { BarChart3, Bot, Users } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Points worth making to someone who is one field away from signing in.
 * Capability, not adjectives — this panel is read in about two seconds.
 */
const HIGHLIGHTS = [
  {
    icon: Users,
    title: "One inbox, whole team",
    body: "WhatsApp, Instagram and web chat in a single shared thread.",
  },
  {
    icon: Bot,
    title: "Automations that reply",
    body: "No-code flows that qualify, route and follow up on their own.",
  },
  {
    icon: BarChart3,
    title: "Broadcasts that convert",
    body: "Segment contacts, send campaigns, track every delivery.",
  },
] as const;

/**
 * Shared frame for /login, /signup, /forgot-password and
 * /reset-password.
 *
 * Two panels on desktop — form left, brand right — collapsing to the
 * form alone on mobile, where a decorative half-screen would just push
 * the password field below the fold.
 *
 * It exists as one component because the four auth pages had drifted
 * into four slightly different cards; anything shared (the frame, the
 * terms notice, the panel) now changes in one place.
 */
export function AuthShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 p-6 md:p-10">
      <div className={cn("flex w-full max-w-sm flex-col gap-6 md:max-w-3xl", className)}>
        <Card className="overflow-hidden py-0">
          <CardContent className="grid p-0 md:grid-cols-2">
            <div className="flex flex-col justify-center p-6 md:p-8">{children}</div>
            <BrandPanel />
          </CardContent>
        </Card>
        <TermsNotice />
      </div>
    </div>
  );
}

/** "Or continue with" rule. A border with the label knocked out of it. */
export function AuthDivider({ label }: { label: string }) {
  return (
    <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
      <span className="relative z-10 bg-card px-2 text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/** Inline form error. `role="alert"` so screen readers announce it. */
export function AuthFormError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

/**
 * Decorative half. `hidden md:flex` rather than a responsive image:
 * there is no marketing artwork in this repo, and a gradient costs no
 * bytes and never renders at the wrong aspect ratio.
 */
function BrandPanel() {
  return (
    <div className="relative hidden flex-col justify-between gap-8 bg-primary p-8 text-primary-foreground md:flex">
      {/* Soft radial wash so the flat brand green reads as a surface
          rather than a swatch. Pointer-events off — it covers the panel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.28),transparent_60%)]"
      />

      <div className="relative">
        {/* The wordmark has white glyphs in it, so it needs a light
            plate — same treatment as the collapsed rail. */}
        <span className="inline-flex items-center rounded-lg bg-white px-3 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- static
              brand SVG; next/image would add a loader round-trip for it. */}
          <img
            src="/brand/converse360-wordmark.svg"
            alt="Converse360"
            className="h-6 w-auto object-contain"
          />
        </span>
      </div>

      <ul className="relative flex flex-col gap-6">
        {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
              <Icon className="size-4.5" />
            </span>
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium">{title}</p>
              <p className="text-sm text-primary-foreground/80">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="relative text-xs text-primary-foreground/70">
        Built on the official WhatsApp Business Cloud API.
      </p>
    </div>
  );
}

/**
 * Plain text, deliberately not links: this repo has no /terms or
 * /privacy route, and a 404 under a legal notice is worse than no
 * anchor at all. Wrap the two names in <Link> once those pages exist.
 */
function TermsNotice() {
  return (
    <p className="text-center text-xs text-balance text-muted-foreground">
      By continuing, you agree to our Terms of Service and Privacy Policy.
    </p>
  );
}
