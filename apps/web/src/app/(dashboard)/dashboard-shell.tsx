"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Settings as SettingsIcon } from "lucide-react";

import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useOnboardingGate } from "@/hooks/use-onboarding-gate";
import { useNavPrefs } from "@/hooks/use-nav-prefs";
import { ChannelStatusProvider } from "@/hooks/use-channel-status";
import { AiCreditsProvider } from "@/hooks/use-ai-credits";
import { PrimaryRail } from "@/components/layout/primary-rail";
import { SecondaryPanel } from "@/components/layout/secondary-panel";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveNavContext } from "@/lib/nav/nav-config";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.
//
// Layout is now three columns: primary rail | secondary panel (only on
// routes that have one) | header + main. Which panel to show, which rows
// to highlight and what the header says all come from a single
// `resolveNavContext(pathname, search)` call — see lib/nav/nav-config.ts.

/**
 * Auth gate — owns the loading / signed-out branches.
 *
 * Deliberately OUTSIDE the `<Suspense>` boundary below, and it must stay
 * there. Suspense boundaries hydrate independently of their parents: when
 * this branch lived inside the boundary, `AuthProvider` (outside it)
 * hydrated and committed first, its effect flipped `loading` to false, and
 * only then did the boundary's children hydrate — rendering the loaded
 * shell against server HTML that still said "spinner". That's a hydration
 * mismatch by construction.
 *
 * With the branch out here, the whole spinner tree hydrates in one pass
 * with `loading: true` (matching the server), and the switch to the real
 * shell afterwards is an ordinary client state update, not hydration.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Only ask once there is a session to ask about; the endpoint is
  // authenticated and would 401 for a signed-out visitor.
  const onboarding = useOnboardingGate(Boolean(user) && !loading);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  useEffect(() => {
    // replace(), not push(): an un-onboarded account pressing Back
    // should not be able to step into the dashboard it was just sent
    // away from.
    if (onboarding === "required") {
      router.replace("/welcome");
    }
  }, [onboarding, router]);

  // The onboarding check is folded into the same spinner as the session
  // so a gated user never sees a flash of the dashboard chrome before
  // being redirected.
  if (loading || (user && onboarding === "checking")) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user || onboarding === "required") return null;

  return <>{children}</>;
}

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { railLocked, toggleRailLock } = useNavPrefs();

  // Rail drawer state — only used on mobile. On lg+ the rail is always
  // visible and this stays closed (ignored by the component).
  //
  // Stored as "the route the drawer was opened on" rather than a plain
  // boolean, so closing-on-navigate is a *derivation* instead of an
  // effect that syncs state to the pathname: the moment the route
  // changes, `drawerOpen` is false on the very same render. Users open
  // the drawer to go somewhere, so it should never survive the trip.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const drawerOpen = openedAt !== null && openedAt === pathname;
  const openDrawer = useCallback(() => setOpenedAt(pathname), [pathname]);
  const closeDrawer = useCallback(() => setOpenedAt(null), []);

  const nav = useMemo(
    () => resolveNavContext(pathname, searchParams.toString()),
    [pathname, searchParams],
  );

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the rail isn't positioned there.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenedAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

  return (
    <TooltipProvider>
      <ChannelStatusProvider>
        {/* One balance for the header badge, the top-up sheet and the
            Provider tab. Three separate fetches would disagree the
            moment one of them spent a credit. */}
        <AiCreditsProvider>
        <div className="flex h-screen overflow-hidden bg-background">
          {/* Reports this tab's online/away presence once we know a user is
              signed in. Headless — renders nothing. */}
          <PresenceHeartbeat />

          <PrimaryRail
            locked={railLocked}
            onToggleLock={toggleRailLock}
            activeRailId={nav.activeRailId}
            drawerOpen={drawerOpen}
            onCloseDrawer={closeDrawer}
            // On mobile the panel renders inline inside the rail's drawer
            // rather than as a second column, so pass it through.
            mobilePanel={
              nav.panel && nav.panelTitle
                ? { title: nav.panelTitle, groups: nav.panel }
                : null
            }
          />

          {nav.panel && nav.panelTitle ? (
            <SecondaryPanel
              title={nav.panelTitle}
              groups={nav.panel}
              channel={nav.activeChannel}
              icon={nav.activeChannel ? undefined : SettingsIcon}
              activeItemId={nav.activePanelItemId}
            />
          ) : null}

          <div className="flex flex-1 flex-col overflow-hidden">
            <Header
              onOpenSidebar={openDrawer}
              title={nav.title}
              breadcrumb={nav.breadcrumb}
            />
            {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
            <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
          </div>
        </div>
        </AiCreditsProvider>
      </ChannelStatusProvider>
    </TooltipProvider>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthGate>
        {/* `useSearchParams` in the shell needs a Suspense boundary — the
            panel disambiguates `?tab=` siblings from the query string.
            It sits INSIDE AuthGate on purpose; see the note there. */}
        <Suspense fallback={null}>
          <DashboardShellInner>{children}</DashboardShellInner>
        </Suspense>
      </AuthGate>
    </AuthProvider>
  );
}
