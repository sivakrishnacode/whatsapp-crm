'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Tabs that are routes. Each tab is its own URL (deep-linkable, survives a
 * refresh, back/forward work), and the active one is read from the pathname
 * rather than passed down, so a layout can render them once for every child
 * page.
 *
 * `exact` tabs match only their own path — the base tab of a section would
 * otherwise light up on every sub-route.
 */
export type RouteTab = {
  href: string;
  label: string;
  exact?: boolean;
  count?: number;
};

export function RouteTabs({
  tabs,
  label,
}: {
  tabs: RouteTab[];
  label: string;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label={label}
      className="border-line -mb-px flex gap-1 overflow-x-auto border-b"
    >
      {tabs.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors ${
              active
                ? 'border-primary text-ink'
                : 'text-muted hover:text-ink border-transparent'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 ? (
              <span className="bg-surface-3 text-ink-2 tabular rounded-full px-1.5 text-[11px] leading-4 font-semibold">
                {tab.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
