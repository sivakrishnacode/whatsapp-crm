"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useAuth, type Workspace } from "@/hooks/use-auth";
import { WorkspaceLogo } from "@/components/workspace/workspace-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Switch workspace without signing out.
 *
 * The header already drew the workspace's logo and name; this turns that chip
 * into the trigger rather than adding a second place that answers "where am I".
 *
 * ⚠️ IT RENDERS EVEN WHEN THERE IS ONE WORKSPACE, as a plain chip with no
 * chevron. The alternative — hide it until you have two — means the control
 * appears in a place you have never looked the first time you need it, which is
 * the moment somebody invites you into a second workspace.
 *
 * ⚠️ AND IT MUST STAY REACHABLE ON /billing AND /welcome. An agency whose one
 * client's plan lapsed is bounced to the billing screen for THAT workspace; if
 * the switcher only lived inside the dashboard chrome they would have no way
 * back to a workspace that still works. That is a layout decision enforced
 * where those screens are composed, not here — but it is why the standing dot
 * below exists at all.
 */

/** Does this workspace need the owner's attention, and what for? */
function attention(w: Workspace): string | null {
  // ⚠️ `grace` is dunning — the workspace still WORKS (get_account_entitlement
  // grades a past_due subscription as entitled). Flagging it identically to
  // `lapsed` would tell someone whose card bounced once that their workspace is
  // dead, so it gets its own softer wording and colour.
  if (w.standing === "lapsed") return "Subscription expired";
  if (w.standing === "grace") return "Payment overdue";
  if (!w.onboarding_done) return "Setup unfinished";
  return null;
}

function dotClass(w: Workspace): string {
  if (w.standing === "lapsed") return "bg-destructive";
  if (w.standing === "grace") return "bg-amber-500";
  return "bg-muted-foreground/40";
}

export function WorkspaceSwitcher() {
  const { workspaces, activeWorkspace, workspacesLoading, switchWorkspace } =
    useAuth();
  const [switching, setSwitching] = useState<string | null>(null);

  // Nothing to show yet. Deliberately renders nothing rather than a skeleton:
  // the header is the first paint, and a shimmering block where the workspace
  // name will be is more distracting than the name simply arriving.
  if (workspacesLoading && !activeWorkspace) return null;
  if (!activeWorkspace) return null;

  const single = workspaces.length <= 1;

  const chip = (
    <div className="flex min-w-0 items-center gap-2">
      <WorkspaceLogo
        name={activeWorkspace.name}
        logoUrl={activeWorkspace.logo_url}
      />
      <span
        className="truncate text-sm font-medium text-foreground"
        title={activeWorkspace.name}
      >
        {activeWorkspace.name}
      </span>
      {!single ? (
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
    </div>
  );

  if (single) {
    return (
      <div className="hidden min-w-0 shrink items-center gap-2 border-r border-border pr-3 md:flex">
        {chip}
      </div>
    );
  }

  async function handleSwitch(id: string) {
    if (id === activeWorkspace?.id) return;
    setSwitching(id);
    try {
      // Hard-navigates on success, so nothing after this runs on the happy
      // path — see `switchWorkspace` for why a soft navigation is not safe.
      await switchWorkspace(id);
    } catch (err) {
      setSwitching(null);
      toast.error(
        err instanceof Error ? err.message : "Could not switch workspace",
      );
    }
  }

  return (
    <div className="hidden min-w-0 shrink items-center border-r border-border pr-3 md:flex">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted"
          aria-label="Switch workspace"
        >
          {chip}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Your workspaces
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {workspaces.map((w) => {
            const note = attention(w);
            const isActive = w.id === activeWorkspace.id;
            return (
              <DropdownMenuItem
                key={w.id}
                onSelect={(event) => {
                  // Keep the menu open while the request is in flight —
                  // closing it first makes a failed switch look like a
                  // successful one that did nothing.
                  event.preventDefault();
                  void handleSwitch(w.id);
                }}
                className="flex items-start gap-2.5 py-2"
              >
                <WorkspaceLogo name={w.name} logoUrl={w.logo_url} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {w.name}
                    </span>
                    {note ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                dotClass(w),
                              )}
                            />
                          }
                        />
                        <TooltipContent>{note}</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                  {/* The role held HERE. An agency operator is an owner in
                      their own workspace and often an agent in a client's,
                      and which one they are changes what the next screen
                      lets them do. */}
                  <span className="text-xs text-muted-foreground">
                    {w.role ?? "member"}
                    {w.plan_name ? ` · ${w.plan_name}` : ""}
                  </span>
                </div>
                {switching === w.id ? (
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                ) : isActive ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-foreground" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
