'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, PanelLeft, Search, Settings as SettingsIcon, User, X } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useTotalUnread } from '@/hooks/use-total-unread';
import { useChannelStatus } from '@/hooks/use-channel-status';
import {
  CHANNELS,
  CHANNEL_ORDER,
  RAIL_BOTTOM,
  RAIL_ONBOARDING,
  RAIL_WORKSPACE,
  channelLandingHref,
  type PanelGroup,
  type RailItem,
} from '@/lib/nav/nav-config';
import { ROLE_META } from '@/components/settings/role-meta';
import { PresenceDot } from '@/components/presence/presence-dot';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The primary rail — first of the two sidebars.
 *
 * Structure mirrors the reference product: logo + collapse pin, a search
 * placeholder, Onboarding, then divider-separated blocks (workspace,
 * channels) with Settings and the user card pinned to the bottom. There
 * are deliberately **no group labels** — dividers carry the grouping,
 * which is what keeps a 10-row rail scannable.
 *
 * Collapsing is a **desktop-only** affordance (`lg:w-14` vs `lg:w-56`).
 * Below `lg` the rail is a 256px drawer where icons-only would waste the
 * width, so labels are hidden via the responsive `lg:hidden` class rather
 * than by conditional rendering — otherwise a user who collapsed the rail
 * at desktop width would get an unreadable icon strip in the mobile
 * drawer. The label markup is always in the tree; only its visibility is
 * breakpoint-dependent.
 */

/**
 * Attaches a tooltip to an already-built element, or returns it
 * untouched when no tooltip is wanted (the labelled rail doesn't need
 * one — the label is right there).
 *
 * `element` becomes the trigger itself rather than being wrapped: base-ui
 * positions the popup against the trigger's box, so wrapping it in a
 * `display: contents` span would leave nothing to anchor to. This is the
 * same `render={<RealElement/>}` shape used in members-tab.tsx and
 * pipeline-analytics.tsx.
 */
function withTooltip(element: ReactElement, label: string | null): ReactNode {
  if (!label) return element;
  return (
    <Tooltip>
      <TooltipTrigger render={element} />
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function UnreadDot({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} unread conversation${count === 1 ? '' : 's'}`}
      className="relative flex size-2 shrink-0"
    >
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-primary" />
    </span>
  );
}

interface PrimaryRailProps {
  /** Labelled (`lg:w-56`) vs icons-only (`lg:w-14`). Desktop only. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Rail row id to highlight, from `resolveNavContext`. */
  activeRailId: string | null;
  /** Mobile drawer state — ignored on `lg:` where the rail is static. */
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  /**
   * The active channel's panel groups. Rendered inline beneath that
   * channel's row on mobile only, so the drawer holds both sidebars.
   */
  mobilePanel?: { title: string; groups: PanelGroup[] } | null;
}

export function PrimaryRail({
  expanded,
  onToggleExpanded,
  activeRailId,
  drawerOpen,
  onCloseDrawer,
  mobilePanel,
}: PrimaryRailProps) {
  const pathname = usePathname();
  const { profile, account, accountRole, signOut } = useAuth();
  const totalUnread = useTotalUnread();
  const statuses = useChannelStatus();

  const collapsed = !expanded;

  // Collapse only takes effect at lg+, so every "is it narrow?" class is
  // an `lg:` variant. See the component docblock.
  const rowClass = collapsed ? 'px-3 lg:justify-center lg:px-0' : 'px-3';
  const labelClass = collapsed ? 'lg:hidden' : '';

  const rowShell = (active: boolean, extra?: string) =>
    cn(
      'flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors',
      rowClass,
      active
        ? 'bg-primary-soft text-primary'
        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      extra,
    );

  const renderRailItem = (item: RailItem) => {
    const isActive = activeRailId === item.id;
    const showDot = item.unreadDot && totalUnread > 0 && !isActive;
    const row = (
      <Link
        href={item.href}
        aria-current={isActive ? 'page' : undefined}
        className={rowShell(isActive)}
      >
        <item.icon className="size-4 shrink-0" />
        <span className={cn('flex-1 truncate', labelClass)}>{item.label}</span>
        {showDot ? <UnreadDot count={totalUnread} /> : null}
      </Link>
    );
    return <li key={item.id}>{withTooltip(row, collapsed ? item.label : null)}</li>;
  };

  return (
    <>
      {/* Mobile backdrop. Clicking closes the drawer; absent on lg+ where
          the rail is part of the flex row. */}
      <button
        type="button"
        aria-label="Close menu"
        onClick={onCloseDrawer}
        className={cn(
          'fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden',
          drawerOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        aria-label="Primary"
        data-sidebar-nav="true"
        className={cn(
          // Mobile: fixed drawer sliding in from the left, always labelled.
          'fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col border-r border-border bg-card',
          'transition-transform duration-200 ease-out will-change-transform',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
          // Desktop: static column whose width follows the pref.
          'lg:static lg:z-0 lg:translate-x-0 lg:transition-[width] lg:duration-150',
          collapsed ? 'lg:w-14' : 'lg:w-56',
        )}
      >
        {/* Logo + collapse pin */}
        <div
          className={cn(
            'flex h-14 shrink-0 items-center gap-2',
            collapsed ? 'px-3 lg:justify-center lg:px-0' : 'px-3',
          )}
        >
          <Link
            href="/dashboard"
            className="flex min-w-0 items-center gap-2"
            aria-label="Conceps WA home"
          >
            <img
              src="/conceps-logo/conceps-logo-01.svg"
              alt=""
              className="size-8 shrink-0 rounded-lg"
            />
            <span
              className={cn(
                'truncate text-sm font-semibold text-foreground',
                labelClass,
              )}
            >
              Conceps WA
            </span>
          </Link>
          {/* Desktop collapse toggle — the "pin" from the reference. */}
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={expanded}
            className={cn(
              'ml-auto hidden size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              collapsed ? 'lg:hidden' : 'lg:flex',
            )}
          >
            <PanelLeft className="size-4" />
          </button>
          {/* Mobile-only close button. */}
          <button
            type="button"
            onClick={onCloseDrawer}
            aria-label="Close menu"
            className="ml-auto flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Expand affordance for the collapsed desktop rail — the pin
            lives in the logo row when labelled, but there's no room at
            w-14. Hidden on mobile, where the rail is never collapsed. */}
        {collapsed ? (
          <div className="hidden justify-center px-2 pb-1 lg:flex">
            {withTooltip(
              <button
                type="button"
                onClick={onToggleExpanded}
                aria-label="Expand sidebar"
                aria-expanded={false}
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <PanelLeft className="size-4 rotate-180" />
              </button>,
              'Expand sidebar',
            )}
          </div>
        ) : null}

        <nav className="sidebar-nav-scroll flex flex-1 flex-col overflow-y-auto px-2 pb-2">
          {/* Search — visual placeholder. Rendered as a real disabled
              control so wiring a command palette later is a one-file
              change, but it is not focusable or clickable today. */}
          {withTooltip(
            <button
              type="button"
              disabled
              aria-label="Search (coming soon)"
              className={cn(
                'mb-1 flex w-full cursor-not-allowed items-center gap-2 rounded-lg border border-border bg-muted/40 py-2 text-sm text-muted-foreground',
                rowClass,
              )}
            >
              <Search className="size-4 shrink-0" />
              <span className={cn('flex-1 text-left', labelClass)}>Search</span>
              <kbd
                className={cn(
                  'rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]',
                  labelClass,
                )}
              >
                Ctrl
              </kbd>
              <kbd
                className={cn(
                  'rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]',
                  labelClass,
                )}
              >
                K
              </kbd>
            </button>,
            collapsed ? 'Search (coming soon)' : null,
          )}

          <ul className="flex flex-col gap-0.5">{renderRailItem(RAIL_ONBOARDING)}</ul>

          <div className="my-2 border-t border-border" />

          <ul className="flex flex-col gap-0.5">{RAIL_WORKSPACE.map(renderRailItem)}</ul>

          <div className="my-2 border-t border-border" />

          {/* Channel block — brand-coloured icons, which is what makes
              this read as a distinct group rather than more nav. */}
          <ul className="flex flex-col gap-0.5">
            {CHANNEL_ORDER.map((id) => {
              const channel = CHANNELS[id];
              const isActive = activeRailId === `channel-${channel.id}`;
              const locked = channel.status === 'locked';
              const status = statuses[channel.id];

              // Row innards are identical whether the row is a link or a
              // locked span, so build them once.
              const inner = (
                <>
                  <channel.icon
                    className={cn('size-4 shrink-0', !locked && channel.accentClass)}
                  />
                  <span className={cn('flex-1 truncate', labelClass)}>
                    {channel.label}
                  </span>
                  {/* Connection dot — replaces the old red warning dot
                      that used to hang off the Settings row. */}
                  {status?.state === 'connected' ? (
                    <PresenceDot status="online" label={`${channel.label} connected`} />
                  ) : null}
                  {status?.state === 'not_connected' ? (
                    <span
                      aria-label={`${channel.label} not connected`}
                      title={status.message}
                      className="inline-block size-2 shrink-0 rounded-full bg-red-500"
                    />
                  ) : null}
                </>
              );

              const row = locked ? (
                <span
                  aria-disabled="true"
                  className={rowShell(
                    isActive,
                    'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                  )}
                >
                  {inner}
                </span>
              ) : (
                <Link
                  href={channelLandingHref(channel.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={rowShell(isActive)}
                >
                  {inner}
                </Link>
              );

              return (
                <li key={channel.id}>
                  {/* A locked channel always gets its tooltip — that's the
                      only place the "coming soon" reason is stated. */}
                  {withTooltip(
                    row,
                    locked
                      ? `${channel.label} — coming soon`
                      : collapsed
                        ? channel.label
                        : null,
                  )}

                  {/* Mobile: the active channel's panel inlined here, so
                      the single drawer carries both sidebars. */}
                  {mobilePanel && isActive ? (
                    <div className="mt-1 mb-2 ml-4 border-l border-border pl-3 lg:hidden">
                      {mobilePanel.groups.map((group) => (
                        <div key={group.label ?? 'root'} className="mb-2">
                          {group.label ? (
                            <div className="px-3 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase">
                              {group.label}
                            </div>
                          ) : null}
                          <ul className="flex flex-col gap-0.5">
                            {group.items.map((item) => (
                              <li key={item.id}>
                                <Link href={item.href}>
                                  <span
                                    className={cn(
                                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                                      pathname === item.href.split('?')[0]
                                        ? 'bg-primary-soft text-primary'
                                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                                    )}
                                  >
                                    <item.icon className="size-4 shrink-0" />
                                    <span className="flex-1 truncate">{item.label}</span>
                                  </span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {/* Spacer pushes Settings + the user card to the bottom. */}
          <div className="flex-1" />

          <ul className="flex flex-col gap-0.5">{RAIL_BOTTOM.map(renderRailItem)}</ul>
        </nav>

        {/* User card — avatar, full name, presence dot + account name. */}
        <div className="shrink-0 border-t border-border p-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Open account menu"
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg py-2 text-left transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60',
                collapsed ? 'px-2 lg:justify-center lg:px-0' : 'px-2',
              )}
            >
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? 'Avatar'}
                  />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    'U'}
                </AvatarFallback>
              </Avatar>
              <div className={cn('min-w-0 flex-1', labelClass)}>
                <p className="truncate text-sm font-medium text-foreground">
                  {profile?.full_name ?? 'User'}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <PresenceDot status="online" />
                  <span className="truncate" title={account?.name ?? undefined}>
                    {account?.name ?? profile?.email ?? ''}
                  </span>
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              <div className="px-2 py-1.5">
                <p className="truncate text-sm font-medium text-foreground">
                  {profile?.full_name ?? 'User'}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {profile?.email ?? ''}
                </p>
                {accountRole
                  ? (() => {
                      const meta = ROLE_META[accountRole];
                      const Icon = meta.icon;
                      return (
                        <span
                          className={cn(
                            'mt-1.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase',
                            meta.className,
                          )}
                        >
                          <Icon className="size-3" />
                          {meta.label}
                        </span>
                      );
                    })()
                  : null}
              </div>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onCloseDrawer}
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
                    onClick={onCloseDrawer}
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
      </aside>
    </>
  );
}
