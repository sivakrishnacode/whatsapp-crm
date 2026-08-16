import type { ComponentType, ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'

/**
 * The one card shell every analytics widget sits in.
 *
 * It owns the loading / empty / content decision as well as the frame,
 * because a widget that renders its own skeleton inevitably renders it
 * at a slightly different height and the grid jumps as each one
 * settles.
 */
export function Panel({
  title,
  subtitle,
  icon: Icon,
  actions,
  loading,
  empty,
  emptyTitle,
  emptyHint,
  emptyIcon,
  skeletonClassName = 'h-56 w-full',
  className,
  bodyClassName,
  children,
}: {
  title: string
  subtitle?: string
  icon?: ComponentType<{ className?: string }>
  /** Range tabs, a "view all" link, a legend — anything header-right. */
  actions?: ReactNode
  loading?: boolean
  /** True when the query succeeded but there is nothing to draw. */
  empty?: boolean
  emptyTitle?: string
  emptyHint?: string
  emptyIcon?: ComponentType<{ className?: string }>
  skeletonClassName?: string
  className?: string
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <section
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card',
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{title}</span>
          </h2>
          {subtitle && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>

      <div className={cn('flex-1 p-5', bodyClassName)}>
        {loading ? (
          <Skeleton className={skeletonClassName} />
        ) : empty ? (
          <EmptyState
            title={emptyTitle ?? 'Nothing in this period'}
            hint={emptyHint}
            icon={emptyIcon}
          />
        ) : (
          children
        )}
      </div>
    </section>
  )
}

/** Muted, uppercase label used above a group of panels. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
    </h2>
  )
}
