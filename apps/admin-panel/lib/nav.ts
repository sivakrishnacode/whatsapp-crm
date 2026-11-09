import type { Capability } from '@/lib/staff/roles';

/**
 * The Control Center's navigation — one list, read by the server (to filter
 * by capability) and by the client rail (to render and highlight).
 *
 * Grouped by what the operator came to do, in the order of the C2.0 revised
 * sidebar: run today's operations, look after clients, manage revenue, then
 * govern the platform. Every href is a stable route — never an index — so a
 * deep link, a refresh and back/forward all land on the same screen.
 *
 * `icon` is a name resolved in the client rail, because a component cannot
 * cross the server → client boundary as a prop.
 */

export type NavIcon =
  | 'overview'
  | 'incidents'
  | 'support'
  | 'onboarding'
  | 'clients'
  | 'portfolio'
  | 'health'
  | 'integrations'
  | 'users'
  | 'subscriptions'
  | 'plans'
  | 'credits'
  | 'catalog'
  | 'staff'
  | 'audit'
  | 'settings';

export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  capability: Capability;
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    label: 'Operations',
    items: [
      {
        href: '/',
        label: 'Overview',
        icon: 'overview',
        capability: 'clients.read',
      },
      {
        href: '/incidents',
        label: 'Incident Monitor',
        icon: 'incidents',
        capability: 'clients.read',
      },
      {
        href: '/support',
        label: 'Support Desk',
        icon: 'support',
        capability: 'tickets.work',
      },
      {
        href: '/onboarding',
        label: 'Onboarding Queue',
        icon: 'onboarding',
        capability: 'clients.read',
      },
    ],
  },
  {
    label: 'Clients',
    items: [
      {
        href: '/clients',
        label: 'Manage Clients',
        icon: 'clients',
        capability: 'clients.read',
      },
      {
        href: '/portfolio',
        label: 'Portfolio Analytics',
        icon: 'portfolio',
        capability: 'clients.read',
      },
      {
        href: '/health',
        label: 'Meta & Channel Health',
        icon: 'health',
        capability: 'clients.read',
      },
      {
        href: '/integrations',
        label: 'CRM / API Operations',
        icon: 'integrations',
        capability: 'integrations.read',
      },
      {
        href: '/users',
        label: 'People & Logins',
        icon: 'users',
        capability: 'clients.read',
      },
    ],
  },
  {
    label: 'Revenue',
    items: [
      {
        href: '/subscriptions',
        label: 'Subscriptions & Renewals',
        icon: 'subscriptions',
        capability: 'billing.read',
      },
      {
        href: '/plans',
        label: 'Plans & Pricing',
        icon: 'plans',
        capability: 'billing.read',
      },
      {
        href: '/credits',
        label: 'AI Credits & Usage',
        icon: 'credits',
        capability: 'billing.read',
      },
    ],
  },
  {
    label: 'Platform',
    items: [
      {
        href: '/catalog',
        label: 'AI Catalog',
        icon: 'catalog',
        capability: 'clients.read',
      },
      {
        href: '/staff',
        label: 'Staff & Access',
        icon: 'staff',
        capability: 'staff.manage',
      },
      {
        href: '/audit',
        label: 'Audit Logs',
        icon: 'audit',
        capability: 'audit.read',
      },
      {
        href: '/settings',
        label: 'System Settings',
        icon: 'settings',
        capability: 'settings.manage',
      },
    ],
  },
];

/** Which section owns a pathname — for the top bar's title. */
export function sectionFor(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const group of NAV) {
    for (const item of group.items) {
      const match =
        item.href === '/'
          ? pathname === '/'
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (match && (!best || item.href.length > best.href.length)) best = item;
    }
  }
  return best;
}
