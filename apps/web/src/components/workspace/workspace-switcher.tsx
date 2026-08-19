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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Switch workspace without signing out.
 *
 * Lives at the top of the primary rail, in the slot the disabled search
 * placeholder used to occupy — so the answer to "which client am I in" is the
 * first thing in the column, above every link whose contents it changes.
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
 *
 * ⚠️ At the rail's collapsed 56px width the NAME hides but the LOGO does not.
 * A strip that answers "whose data is this" only when you hover it is a strip
 * you have to interrogate before every click.
 *
 * ⚠️ The reason for a dot is ALSO written into the row's text, not only into a
 * `title`. A colour a person has to hover to decode is not information, and the
 * row it sits on is the one that decides which client's data they are about to
 * open.
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

export function WorkspaceSwitcher({
  className,
  labelClassName,
}: {
  /** Wrapper classes — the rail and the header want very different boxes. */
  className?: string;
  /**
   * Applied to everything except the logo, so the rail can hide the name and
   * chevron at its collapsed width. The logo survives on purpose: it is the
   * only thing on a 56px rail that still says which client you are in, and a
   * strip that answers that question only on hover is a strip you have to
   * interrogate before every action.
   */
  labelClassName?: string;
}) {
  const { workspaces, activeWorkspace, workspacesLoading, switchWorkspace } =
    useAuth();
  const [switching, setSwitching] = useState<string | null>(null);

  // Nothing to show yet. Deliberately renders nothing rather than a skeleton:
  // this is the first paint, and a shimmering block where the workspace name
  // will be is more distracting than the name simply arriving.
  if (workspacesLoading && !activeWorkspace) return null;
  if (!activeWorkspace) return null;

  const single = workspaces.length <= 1;

  const chip = (
    <>
      <WorkspaceLogo
        name={activeWorkspace.name}
        logoUrl={activeWorkspace.logo_url}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground",
          labelClassName,
        )}
        title={activeWorkspace.name}
      >
        {activeWorkspace.name}
      </span>
      {!single ? (
        <ChevronsUpDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            labelClassName,
          )}
        />
      ) : null}
    </>
  );

  if (single) {
    return (
      <div className={cn("flex min-w-0 items-center gap-2", className)}>
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
    <div className={cn("flex min-w-0", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 py-2 text-sm transition-colors hover:bg-muted"
          aria-label="Switch workspace"
        >
          {chip}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-72">
          {/* ⚠ The Group is REQUIRED, not decoration. DropdownMenuLabel is
              base-ui's Menu.GroupLabel, which reads a Menu.Group context and
              THROWS at render when it is missing (Base UI error #31) — the
              menu never renders and the exception takes the whole page down
              with it, which is what "This page couldn't load" looked like
              here. Issue #336, pinned by
              ui/dropdown-menu-group-label.test.tsx. A label always goes
              inside a DropdownMenuGroup. */}
          <DropdownMenuGroup>
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
                  // ⚠️ `onClick`, NOT `onSelect`. This is base-ui, not Radix:
                  // Menu.Item has no `onSelect`, so the handler was spread
                  // onto the DOM as an unknown prop and silently never ran —
                  // the menu closed, nothing happened, and there was no error
                  // anywhere to notice. Every other menu in this app uses
                  // `onClick`; follow them.
                  //
                  // `closeOnClick={false}` is base-ui's way of keeping it
                  // open while the request is in flight — closing first makes
                  // a failed switch look like a successful one that did
                  // nothing.
                  closeOnClick={false}
                  onClick={() => void handleSwitch(w.id)}
                  className="flex items-start gap-2.5 py-2"
                >
                  <WorkspaceLogo name={w.name} logoUrl={w.logo_url} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">
                        {w.name}
                      </span>
                      {note ? (
                        <span
                          title={note}
                          aria-label={note}
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            dotClass(w),
                          )}
                        />
                      ) : null}
                    </div>
                    {/* The role held HERE. An agency operator is an owner in
                        their own workspace and often an agent in a client's,
                        and which one they are changes what the next screen
                        lets them do. */}
                    <span className="text-xs text-muted-foreground">
                      {w.role ?? "member"}
                      {w.plan_name ? ` · ${w.plan_name}` : ""}
                      {note ? ` · ${note.toLowerCase()}` : ""}
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
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
