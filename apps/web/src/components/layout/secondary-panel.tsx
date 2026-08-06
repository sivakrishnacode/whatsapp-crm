'use client';

import Link from 'next/link';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { NavIcon } from '@/lib/nav/channels';

import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useChannelStatus } from '@/hooks/use-channel-status';
import type { ChannelDef, PanelGroup } from '@/lib/nav/nav-config';

/**
 * The second sidebar — shown only for routes that have one (the three
 * channels and Settings). Everything else gets no panel at all, which is
 * what keeps the three-column inbox and the flow builder full-width.
 *
 * Rows are links rather than buttons even for Settings, where selection
 * used to be local state: `?tab=` remains the source of truth, so every
 * existing deep link keeps working and the panel needs no callback.
 *
 * Hidden below `lg` — on mobile these groups render inline inside the
 * primary rail's drawer instead (one drawer, no nested focus trap).
 */

function StatusChip({
  state,
  message,
}: {
  state: 'loading' | 'connected' | 'not_connected' | 'unavailable';
  message?: string;
}) {
  if (state === 'loading') return null;

  const meta: Record<string, { label: string; className: string }> = {
    connected: {
      label: 'Connected',
      className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600',
    },
    not_connected: {
      label: 'Not connected',
      className: 'border-red-500/40 bg-red-500/10 text-red-600',
    },
    unavailable: {
      label: 'Coming soon',
      className: 'border-border bg-muted text-muted-foreground',
    },
  };
  const m = meta[state];
  if (!m) return null;

  return (
    <span
      title={message}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        m.className,
      )}
    >
      {m.label}
    </span>
  );
}

interface SecondaryPanelProps {
  /** Panel header label ("WhatsApp", "Settings"). */
  title: string;
  groups: PanelGroup[];
  /** Set for channel panels — drives the header icon and status chip. */
  channel: ChannelDef | null;
  /** Header icon for non-channel panels (Settings). */
  icon?: NavIcon;
  /** Row to highlight, from `resolveNavContext`. */
  activeItemId: string | null;
  open: boolean;
  onToggle: () => void;
}

export function SecondaryPanel({
  title,
  groups,
  channel,
  icon: FallbackIcon,
  activeItemId,
  open,
  onToggle,
}: SecondaryPanelProps) {
  const { canEditSettings, isOwner } = useAuth();
  const statuses = useChannelStatus();

  const HeaderIcon = channel?.icon ?? FallbackIcon;
  const status = channel ? statuses[channel.id] : null;

  // Collapsed: a thin reopen strip rather than nothing, so the panel is
  // recoverable without going back through the rail.
  if (!open) {
    return (
      <div className="hidden w-10 shrink-0 flex-col items-center border-r border-border bg-card pt-4 lg:flex">
        <button
          type="button"
          onClick={onToggle}
          aria-label={`Show ${title} menu`}
          aria-expanded={false}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <aside
      aria-label={`${title} menu`}
      className="hidden w-56 shrink-0 flex-col border-r border-border bg-card lg:flex"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        {HeaderIcon ? (
          <HeaderIcon className={cn('size-4 shrink-0', channel?.accentClass)} />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {title}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-label={`Hide ${title} menu`}
          aria-expanded
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelLeftClose className="size-4" />
        </button>
      </div>

      {status ? (
        <div className="shrink-0 px-3 pb-2">
          <StatusChip state={status.state} message={status.message} />
        </div>
      ) : null}

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((group) => {
          const items = group.items.filter((i) => {
            // ownerOnly is checked before adminOnly and is stricter:
            // an admin passes canEditSettings but must not see billing.
            if (i.ownerOnly) return isOwner;
            return !i.adminOnly || canEditSettings;
          });
          if (items.length === 0) return null;

          return (
            <div key={group.label ?? 'root'} className="mb-1">
              {group.label ? (
                <div className="px-3 pt-3 pb-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase">
                  {group.label}
                </div>
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => {
                  // Active state is resolved once by `resolveNavContext`
                  // so the tie-breaking rules (?tab= siblings, legacy tab
                  // aliases, flat routes inside a channel panel) live in
                  // one place instead of being re-derived per surface.
                  const isActive = item.id === activeItemId;
                  return (
                    <li key={item.id}>
                      <Link
                        href={item.href}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-primary-soft text-primary'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        <item.icon className="size-4 shrink-0" />
                        <span className="flex-1 truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
