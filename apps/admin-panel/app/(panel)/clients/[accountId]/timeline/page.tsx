import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { Pill, type Tone } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth';
import { adminTimezone } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { isUuid } from '@/lib/ids';
import { getTimeline, type TimelineItem } from '@/lib/queries/clients';

export const metadata: Metadata = { title: 'Timeline · Customer 360' };

const KIND: Record<TimelineItem['kind'], { label: string; tone: Tone }> = {
  milestone: { label: 'Product', tone: 'info' },
  admin: { label: 'Admin change', tone: 'warn' },
  lifecycle: { label: 'Lifecycle', tone: 'primary' },
  note: { label: 'Note', tone: 'neutral' },
  ticket: { label: 'Support', tone: 'good' },
};

/**
 * One chronological story: product milestones from the tenant's own rows,
 * every change made from this panel (admin_audit_log — immutable, no FKs),
 * lifecycle pins, notes and tickets. Read where each lives; nothing copied.
 */
export default async function ClientTimelinePage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  await requireCapability('clients.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();

  const items = await getTimeline(accountId);

  return (
    <Card>
      <CardHeader
        title="Timeline & audit"
        description={`Newest first, times in ${adminTimezone()}. Admin changes come from the immutable audit log.`}
      />
      {items.length === 0 ? (
        <EmptyState>Nothing recorded yet.</EmptyState>
      ) : (
        <ol className="relative px-5 py-4">
          {items.map((item, index) => (
            <li
              key={`${item.at.toISOString()}-${index}`}
              className="relative flex gap-4 pb-5 last:pb-0"
            >
              <div className="flex flex-col items-center">
                <span
                  aria-hidden
                  className="bg-primary ring-surface mt-1.5 size-2.5 rounded-full ring-4"
                />
                {index < items.length - 1 ? (
                  <span aria-hidden className="bg-line mt-1 w-px flex-1" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={KIND[item.kind].tone}>
                    {KIND[item.kind].label}
                  </Pill>
                  <span className="text-muted text-xs">
                    {formatDateTime(item.at)}
                  </span>
                  {item.actor ? (
                    <span className="text-muted text-xs">· {item.actor}</span>
                  ) : null}
                </div>
                <p className="text-ink mt-1 text-sm">
                  {item.href ? (
                    <Link href={item.href} className="hover:underline">
                      {item.title}
                    </Link>
                  ) : (
                    item.title
                  )}
                </p>
                {item.detail ? (
                  <p className="text-muted mt-0.5 text-xs leading-relaxed whitespace-pre-wrap">
                    {item.detail}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
