import { contactSourceMeta } from '@/lib/contacts/source';
import { cn } from '@/lib/utils';
import type { ContactSource } from '@/types';

/**
 * The "where did this contact come from" pill.
 *
 * Deliberately quiet: origin is reference information, not something the
 * eye should be pulled to while scanning a contact list, so the pill is
 * a neutral theme token and only the glyph carries brand colour. See the
 * note in lib/contacts/source.ts for why colour is split that way, and
 * why `dark:` utilities cannot be used anywhere in this app.
 */
export function ContactSourceBadge({
  source,
  className,
}: {
  source: ContactSource | string | null | undefined;
  className?: string;
}) {
  const meta = contactSourceMeta(source);
  const Icon = meta.icon;

  return (
    <span
      title={meta.description}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground',
        className,
      )}
    >
      <Icon className={cn('size-3 shrink-0', meta.iconClass)} />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}
