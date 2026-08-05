import Link from 'next/link';

import { initialsOf } from '@/lib/format';

/**
 * Who a row is about. The name is the link target everywhere it appears, so
 * there is one way to get from any table to a subscriber's detail page.
 */
export function SubscriberIdentity({
  userId,
  fullName,
  email,
  accountName,
}: {
  userId: string;
  fullName: string | null;
  email: string | null;
  accountName?: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden
        className="bg-surface-2 text-ink-2 grid size-8 shrink-0 place-items-center rounded-full text-xs font-medium"
      >
        {initialsOf(fullName, email)}
      </span>
      <span className="min-w-0">
        <Link
          href={`/subscribers/${userId}`}
          className="text-ink block truncate font-medium underline-offset-2 hover:underline"
        >
          {fullName || email || 'Unnamed user'}
        </Link>
        <span className="text-muted block truncate text-xs">
          {fullName && email ? email : null}
          {fullName && email && accountName ? ' · ' : null}
          {accountName ?? (!fullName && !email ? userId : null)}
        </span>
      </span>
    </div>
  );
}
