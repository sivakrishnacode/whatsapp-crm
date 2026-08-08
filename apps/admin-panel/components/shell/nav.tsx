'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Sidebar navigation. Client-side only because it needs `usePathname` to mark
 * the current section — everything else in the shell stays a Server Component.
 */

/**
 * Ordered by what the section is *about*, not alphabetically: money first
 * (overview → subscribers → sales → plans), then tenants (workspaces →
 * users → AI credits), then the record of what was changed.
 */
const ITEMS = [
  { href: '/', label: 'Overview' },
  { href: '/subscribers', label: 'Subscribers' },
  { href: '/sales', label: 'Sales' },
  { href: '/plans', label: 'Plans & pricing' },
  { href: '/workspaces', label: 'Workspaces' },
  { href: '/users', label: 'Users' },
  { href: '/credits', label: 'AI credits' },
  { href: '/audit', label: 'Audit log' },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Sections" className="flex gap-1 lg:flex-col">
      {ITEMS.map((item) => {
        // Overview owns "/" exactly; every other section also owns its
        // sub-routes, so /subscribers/<id> keeps Subscribers highlighted.
        const active =
          item.href === '/'
            ? pathname === '/'
            : pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg px-3 py-2 text-sm whitespace-nowrap transition ${
              active
                ? 'bg-surface text-ink border-ring border font-medium'
                : 'text-ink-2 hover:bg-surface/70 border border-transparent'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
