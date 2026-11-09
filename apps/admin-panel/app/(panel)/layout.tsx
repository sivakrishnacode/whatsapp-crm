import { KeyRound, LogOut, Search } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { MobileNav } from '@/components/shell/mobile-nav';
import { Nav } from '@/components/shell/nav';
import { logout } from '@/lib/actions/auth';
import { can, requireStaff } from '@/lib/auth';
import { adminTimezone, currency } from '@/lib/env';
import { initialsOf } from '@/lib/format';
import { NAV } from '@/lib/nav';
import { prisma } from '@/lib/prisma';
import { ROLE_LABEL } from '@/lib/staff/roles';

/**
 * The authenticated shell: navy rail, top bar with global client search and
 * the signed-in staff member, and the page.
 *
 * `requireStaff()` here protects the render and nothing else — each page and
 * every Server Action checks its own capability again.
 */
export default async function PanelLayout({
  children,
}: {
  children: ReactNode;
}) {
  const staff = await requireStaff();

  const allowed = NAV.flatMap((group) => group.items)
    .filter((item) => can(staff, item.capability))
    .map((item) => item.href);

  // One cheap, indexed count for the rail: open tickets nobody owns. The
  // fleet health scan is deliberately NOT run here — it would cost every
  // page load a pass over every workspace.
  const unassigned = can(staff, 'tickets.work')
    ? await prisma.support_tickets.count({
        where: {
          assignee_staff_id: null,
          status: { notIn: ['resolved', 'closed'] },
        },
      })
    : 0;

  const brand = (
    <Link href="/" className="block px-1">
      <span className="text-rail-ink-strong text-[19px] font-extrabold tracking-tight">
        Converse<span className="text-[#80abed]">360</span>
      </span>
      <span className="text-rail-muted block text-[10px] font-semibold tracking-[0.16em] uppercase">
        Control Center
      </span>
    </Link>
  );

  const nav = <Nav allowed={allowed} badges={{ '/support': unassigned }} />;

  return (
    <div className="min-h-dvh lg:pl-[248px]">
      <aside className="rail bg-rail fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col lg:flex">
        <div className="px-5 pt-5 pb-4">{brand}</div>
        <div className="rail-scroll flex-1 overflow-y-auto px-3 pb-4">
          {nav}
        </div>
        <div className="border-rail-2 text-rail-muted border-t px-5 py-4 text-[11px] leading-relaxed">
          Amounts in {currency()} · Times in {adminTimezone()}
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="border-line bg-surface/90 sticky top-0 z-20 border-b backdrop-blur">
          <div className="mx-auto flex h-16 w-full max-w-[1500px] items-center gap-3 px-4 lg:px-8">
            <MobileNav brand={brand}>
              <Nav allowed={allowed} badges={{ '/support': unassigned }} />
            </MobileNav>

            <form
              action="/clients"
              method="get"
              role="search"
              className="relative max-w-md min-w-0 flex-1"
            >
              <Search
                aria-hidden
                className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              />
              <label htmlFor="global-search" className="sr-only">
                Search clients
              </label>
              <input
                id="global-search"
                name="q"
                type="search"
                placeholder="Search clients — name, email, WABA or phone ID, tenant ID"
                className="border-ring bg-surface-2 text-ink placeholder:text-muted focus:border-primary focus:bg-surface h-10 w-full rounded-lg border pr-3 pl-9 text-sm"
              />
            </form>

            <div className="ml-auto flex items-center gap-2">
              <details className="group relative">
                <summary className="hover:bg-surface-2 flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-2 py-1.5 [&::-webkit-details-marker]:hidden">
                  <span
                    aria-hidden
                    className="bg-primary-soft text-primary-soft-ink grid size-8 place-items-center rounded-full text-xs font-bold"
                  >
                    {initialsOf(staff.name, staff.email)}
                  </span>
                  <span className="hidden text-left sm:block">
                    <span className="text-ink block max-w-40 truncate text-[13px] leading-tight font-semibold">
                      {staff.name}
                    </span>
                    <span className="text-muted block text-[11px] leading-tight">
                      {ROLE_LABEL[staff.role]}
                    </span>
                  </span>
                </summary>
                <div className="border-ring bg-surface shadow-pop absolute right-0 mt-2 w-64 rounded-xl border p-2">
                  <div className="border-line border-b px-2.5 pt-1.5 pb-2.5">
                    <p className="text-ink truncate text-sm font-semibold">
                      {staff.name}
                    </p>
                    <p className="text-muted truncate text-xs">{staff.email}</p>
                    {staff.isBreakGlass ? (
                      <p className="bg-warn-soft text-warn-fg mt-2 rounded-md px-2 py-1 text-[11px] leading-snug">
                        Break-glass login. Create a staff account for day-to-day
                        use.
                      </p>
                    ) : null}
                  </div>
                  {staff.isBreakGlass ? null : (
                    <Link
                      href="/account"
                      className="text-ink-2 hover:bg-surface-2 mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm"
                    >
                      <KeyRound aria-hidden className="size-4" />
                      Change password
                    </Link>
                  )}
                  <form action={logout}>
                    <button
                      type="submit"
                      className="text-ink-2 hover:bg-surface-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm"
                    >
                      <LogOut aria-hidden className="size-4" />
                      Sign out
                    </button>
                  </form>
                </div>
              </details>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1500px] min-w-0 flex-1 px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
