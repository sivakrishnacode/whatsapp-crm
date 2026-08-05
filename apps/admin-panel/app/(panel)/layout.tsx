import type { ReactNode } from 'react';

import { Nav } from '@/components/shell/nav';
import { logout } from '@/lib/actions/auth';
import { requireAdmin } from '@/lib/auth';
import { currency } from '@/lib/env';

/**
 * The authenticated shell.
 *
 * `requireAdmin()` here covers every page in the group, but it is not the only
 * check — each page's data functions and every Server Action verify again, since
 * a layout check protects the render and nothing else.
 */
export default async function PanelLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireAdmin();

  return (
    <div className="mx-auto flex w-full max-w-[100rem] flex-1 flex-col gap-6 px-4 py-6 lg:flex-row lg:px-8">
      <aside className="lg:w-52 lg:shrink-0">
        <div className="flex items-center justify-between gap-4 lg:block">
          <div>
            <p className="text-ink text-sm font-semibold">Converse360</p>
            <p className="text-muted text-xs">Admin · billing</p>
          </div>

          <form action={logout} className="lg:hidden">
            <button
              type="submit"
              className="text-muted hover:text-ink text-xs underline-offset-2 hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>

        <div className="mt-4 lg:mt-6">
          <Nav />
        </div>

        <div className="border-line text-muted mt-6 hidden border-t pt-4 text-xs lg:block">
          <p>
            Signed in as{' '}
            <span className="text-ink-2 font-medium">{session.username}</span>
          </p>
          <p className="mt-1">Amounts in {currency()}</p>
          <form action={logout} className="mt-3">
            <button
              type="submit"
              className="hover:text-ink underline-offset-2 hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
