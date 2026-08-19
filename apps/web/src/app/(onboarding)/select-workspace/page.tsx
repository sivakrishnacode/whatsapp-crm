"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { WorkspaceLogo } from "@/components/workspace/workspace-logo";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { cn } from "@/lib/utils";

/**
 * "Which workspace do you want to continue in?"
 *
 * Shown straight after sign-in, and ONLY when the answer is not obvious. An
 * agency signing in has a dozen clients and no way to know which one the app
 * decided to open; asking once, at the moment of entry, is cheaper than
 * noticing later that you have been reading the wrong client's inbox.
 *
 * ⚠️ IT FORWARDS SILENTLY FOR EVERYBODY ELSE. With one workspace there is no
 * choice to make, and with none there is nothing to choose from — a screen that
 * asks a question with one answer is a screen that trains people to click
 * through without reading. Single-workspace users, still the large majority,
 * never see this.
 *
 * ⚠️ It sits OUTSIDE the dashboard shell, in `(onboarding)`, on purpose: the
 * shell's AuthGate resolves an active workspace and runs the onboarding gate,
 * which is precisely the work this page exists to happen *before*. Rendering it
 * inside would pick a workspace, gate on that workspace's plan, and possibly
 * bounce to `/welcome` for a client the user never meant to open.
 *
 * Every sign-in path reaches it through one seam — `DEFAULT_POST_AUTH_PATH` —
 * so password login, Google OAuth and the email-confirmation callback all
 * behave the same without three copies of this decision.
 */

type Workspace = {
  id: string;
  name: string;
  logo_url: string | null;
  role: string | null;
  is_owner: boolean;
  member_count: number;
  plan_name: string | null;
  standing: "good" | "grace" | "lapsed" | null;
};

function SelectWorkspaceInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Attacker-controlled, same as everywhere else `?next=` is read.
  const next = sanitizeNextPath(searchParams.get("next"), "/dashboard");

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/account/workspaces", {
          cache: "no-store",
        });
        if (!res.ok) {
          // Don't strand them here on a transient failure — the dashboard's own
          // gate will make the same decision, and it fails open by design.
          if (!cancelled) router.replace(next);
          return;
        }
        const body = (await res.json()) as { workspaces: Workspace[] };
        const list = body.workspaces ?? [];
        if (cancelled) return;

        // Nothing to ask. `<= 1` covers zero too: the dashboard shell renders
        // the honest "you're not in any workspace" screen, and duplicating that
        // message here would be a second place to keep it true.
        if (list.length <= 1) {
          router.replace(next);
          return;
        }
        setWorkspaces(list);
      } catch {
        if (!cancelled) router.replace(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, next]);

  const choose = useCallback(
    async (id: string) => {
      setChoosing(id);
      try {
        const res = await fetch("/api/account/workspaces/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: id }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "Could not open that workspace");
        }
        // Hard navigation, not router.push: the app is about to mount its
        // account-keyed caches and realtime channels, and they must start from
        // the workspace that was just chosen rather than one resolved earlier.
        window.location.assign(next);
      } catch (err) {
        setChoosing(null);
        toast.error(
          err instanceof Error ? err.message : "Could not open that workspace",
        );
      }
    },
    [next],
  );

  // Deciding, or forwarding. Same spinner the dashboard shell shows, so the
  // common single-workspace path looks like one continuous load rather than a
  // screen that appeared and vanished.
  if (!workspaces) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-foreground">
            Choose a workspace
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You&apos;re a member of {workspaces.length} workspaces. You can
            switch at any time from the header.
          </p>
        </div>

        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {workspaces.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() => void choose(w.id)}
                disabled={choosing !== null}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                  "hover:bg-muted disabled:pointer-events-none disabled:opacity-60",
                )}
              >
                <WorkspaceLogo name={w.name} logoUrl={w.logo_url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {w.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {/* The role held HERE, which is what changes what they can
                        do on the other side of this click. */}
                    {w.role ?? "member"}
                    {w.member_count > 1 ? ` · ${w.member_count} members` : ""}
                    {/* `grace` is dunning and still entitled — it gets a note,
                        not the same warning as an expired workspace. */}
                    {w.standing === "lapsed"
                      ? " · subscription expired"
                      : w.standing === "grace"
                        ? " · payment overdue"
                        : ""}
                  </p>
                </div>
                {choosing === w.id ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function SelectWorkspacePage() {
  // `useSearchParams` needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <SelectWorkspaceInner />
    </Suspense>
  );
}
