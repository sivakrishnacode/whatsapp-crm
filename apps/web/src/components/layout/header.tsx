"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { Bell, LogOut, Menu, Settings as SettingsIcon, User } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { WorkspaceLogo } from "@/components/workspace/workspace-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModeToggle } from "@/components/layout/mode-toggle";
import { AlertSettingsMenu } from "@/components/layout/alert-settings-menu";
import { AiCreditsBadge } from "@/components/ai/ai-credits-badge";

interface HeaderProps {
  /** Wired to the shell's drawer state. Used only on mobile — the
   *  hamburger button is hidden on lg+. */
  onOpenSidebar?: () => void;
  /**
   * Page title, resolved by `resolveNavContext` in the shell. Replaces
   * the hardcoded path→title map this component used to carry, which
   * silently fell back to "Dashboard" for anything not listed.
   */
  title: string;
  /** Section prefix, e.g. "WhatsApp" on "WhatsApp / Templates". */
  breadcrumb?: string | null;
}

export function Header({ onOpenSidebar, title, breadcrumb }: HeaderProps) {
  const pathname = usePathname();
  const { profile, account, accountRole, signOut } = useAuth();
  const unreadNotifications = useUnreadNotifications();

  const onNotifications = pathname.startsWith("/notifications");

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    "U";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only. 44×44 hit target per Apple HIG. */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open menu"
          className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Which workspace am I in?
            Multi-tenant apps put this top-left because the same person
            can own one workspace and be an agent in another — and every
            number on the page below means something different depending
            on which. The rail footer shows it too, but the rail
            collapses and is hidden entirely on mobile, so it cannot be
            the only place it appears. */}
        {account?.name ? (
          <div className="hidden min-w-0 shrink items-center gap-2 border-r border-border pr-3 md:flex">
            {/* Their logo when they have uploaded one, the initial when
                they have not — <WorkspaceLogo> owns that choice so the
                header, the settings card and the signup wizard cannot
                drift apart. */}
            <WorkspaceLogo name={account.name} logoUrl={account.logo_url} />
            <span
              className="truncate text-sm font-medium text-foreground"
              title={account.name}
            >
              {account.name}
            </span>
          </div>
        ) : null}

        <h1 className="flex min-w-0 items-baseline gap-1.5 truncate text-base font-semibold text-foreground sm:text-lg">
          {breadcrumb ? (
            <>
              {/* Hidden on mobile — at 375px the channel prefix eats the
                  whole line and the page name is what matters. */}
              <span className="hidden shrink-0 font-normal text-muted-foreground sm:inline">
                {breadcrumb}
              </span>
              <span className="hidden shrink-0 text-muted-foreground sm:inline">/</span>
            </>
          ) : null}
          <span className="truncate">{title}</span>
        </h1>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        {/* How much built-in AI is left. Sits before the bell because it
            is the only thing here that can stop a feature working, and
            it renders nothing on a bring-your-own-key workspace. */}
        <AiCreditsBadge />

        {/* Notifications. The reference product has no rail entry for
            these, so the bell lives here next to the theme toggle. */}
        <Link
          href="/notifications"
          aria-label={
            unreadNotifications > 0
              ? `Notifications (${unreadNotifications} unread)`
              : "Notifications"
          }
          aria-current={onNotifications ? "page" : undefined}
          className={cn(
            "relative flex size-9 items-center justify-center rounded-md transition-colors",
            onNotifications
              ? "bg-primary-soft text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Bell className="size-[18px]" />
          {unreadNotifications > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {unreadNotifications > 9 ? "9+" : unreadNotifications}
            </span>
          ) : null}
        </Link>

        {/* Also where the app-wide new-message alert subscription is
            mounted — the header is on every dashboard route. */}
        <AlertSettingsMenu />

        <ModeToggle />

        <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70 sm:gap-3 sm:pl-1 sm:pr-3"
          aria-label="Open account menu"
        >
          <Avatar className="size-8">
            {profile?.avatar_url ? (
              <AvatarImage
                src={profile.avatar_url}
                alt={profile.full_name ?? "Avatar"}
              />
            ) : null}
            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-sm font-medium text-foreground sm:inline">
            {profile?.full_name ?? "User"}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">
              {profile?.full_name ?? "User"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {profile?.email ?? ""}
            </p>
            {/* Workspace + role. The role is the useful half: it is the
                answer to "why can't I see billing / members / settings",
                and without it that reads as a bug rather than a
                permission. */}
            {account?.name ? (
              <p className="mt-1.5 truncate text-xs text-muted-foreground">
                <span className="text-foreground">{account.name}</span>
                {accountRole ? ` · ${accountRole}` : null}
              </p>
            ) : null}
          </div>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=profile"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <User className="size-4" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link
                href="/settings"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <SettingsIcon className="size-4" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={signOut}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <LogOut className="size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
