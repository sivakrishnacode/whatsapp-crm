import Link from 'next/link';

import { initialsOf } from '@/lib/format';

/**
 * Who a row is about. The name is the link target everywhere it appears, so
 * there is one way to get from any table to a subscriber's detail page.
 *
 * `href` overrides the target; `null` renders the name as plain text — for a
 * role that cannot open the subscription screen, a link that lands on "no
 * access" is worse than no link.
 */
export function SubscriberIdentity({
  userId,
  fullName,
  email,
  accountName,
  href,
}: {
  userId: string;
  fullName: string | null;
  email: string | null;
  accountName?: string | null;
  href?: string | null;
}) {
  const target = href === undefined ? `/subscriptions/${userId}` : href;
  const label = fullName || email || 'Unnamed user';

  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden
        className="bg-primary-soft text-primary-soft-ink grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold"
      >
        {initialsOf(fullName, email)}
      </span>
      <span className="min-w-0">
        {target ? (
          <Link
            href={target}
            className="text-ink block truncate font-semibold underline-offset-2 hover:underline"
          >
            {label}
          </Link>
        ) : (
          <span className="text-ink block truncate font-semibold">{label}</span>
        )}
        <span className="text-muted block truncate text-xs">
          {fullName && email ? email : null}
          {fullName && email && accountName ? ' · ' : null}
          {accountName ?? (!fullName && !email ? userId : null)}
        </span>
      </span>
    </div>
  );
}
