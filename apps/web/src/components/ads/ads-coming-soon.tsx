import Link from 'next/link';
import { Construction } from 'lucide-react';

/**
 * Placeholder for the Ads Manager panel rows that do not have a surface
 * yet (Overview, Create Ad, Leads, Lead Forms, Audiences, Events).
 *
 * They are listed in the panel from the start rather than added one at a
 * time, so the information architecture is visible and stable while the
 * milestones land — the same reasoning as the channel panels, whose rows
 * exist before their pages do.
 *
 * This says which milestone owns the section rather than a vague "coming
 * soon", because the only people who can see this today are the ones
 * building it.
 */
export function AdsComingSoon({
  title,
  description,
  milestone,
}: {
  title: string;
  description: string;
  milestone: string;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Construction className="size-5" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-foreground">{title}</h1>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
        <p className="mt-4 text-xs text-muted-foreground">
          Lands in <span className="font-medium text-foreground">{milestone}</span>{' '}
          — see{' '}
          <span className="font-mono">docs/meta-ads-manager.md</span>.
        </p>
        <Link
          href="/ads/setup"
          className="mt-5 inline-block text-sm font-medium text-primary underline"
        >
          Finish setup first
        </Link>
      </div>
    </div>
  );
}
