'use client';

import {
  Building2,
  ChartColumn,
  Coins,
  CreditCard,
  HeartPulse,
  LayoutDashboard,
  LifeBuoy,
  Package,
  Rocket,
  ScrollText,
  Settings,
  ShieldCheck,
  Siren,
  Sparkles,
  Users,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { NAV, type NavIcon } from '@/lib/nav';

/**
 * The navy rail's link list. Client-side only because it needs `usePathname`
 * to mark the current section; which items appear is decided on the server
 * (`allowed`) from the staff member's capabilities, so a role never sees a
 * link to a screen that would refuse them.
 */

const ICONS: Record<NavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  incidents: Siren,
  support: LifeBuoy,
  onboarding: Rocket,
  clients: Building2,
  portfolio: ChartColumn,
  health: HeartPulse,
  integrations: Webhook,
  users: Users,
  subscriptions: CreditCard,
  plans: Package,
  credits: Coins,
  catalog: Sparkles,
  staff: ShieldCheck,
  audit: ScrollText,
  settings: Settings,
};

export function Nav({
  allowed,
  badges = {},
  onNavigate,
}: {
  allowed: string[];
  /** Small counts beside a link — open incidents, unassigned tickets. */
  badges?: Record<string, number>;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const allow = new Set(allowed);

  return (
    <nav aria-label="Control Center" className="space-y-4">
      {NAV.map((group) => {
        const items = group.items.filter((item) => allow.has(item.href));
        if (items.length === 0) return null;
        return (
          <div key={group.label}>
            <p className="text-rail-muted mb-1.5 px-3 text-[10px] font-semibold tracking-[0.14em] uppercase">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {items.map((item) => {
                const active =
                  item.href === '/'
                    ? pathname === '/'
                    : pathname === item.href ||
                      pathname.startsWith(`${item.href}/`);
                const Icon = ICONS[item.icon];
                const badge = badges[item.href];
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={`flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
                        active
                          ? 'bg-rail-active text-rail-ink-strong'
                          : 'text-rail-ink hover:bg-rail-2 hover:text-rail-ink-strong'
                      }`}
                    >
                      <Icon
                        aria-hidden
                        className={`size-4 shrink-0 ${active ? 'text-[#8eb8fa]' : 'opacity-75'}`}
                        strokeWidth={1.9}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {item.label}
                      </span>
                      {badge ? (
                        <span className="bg-critical tabular rounded-full px-1.5 text-[10px] leading-4 font-bold text-white">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
