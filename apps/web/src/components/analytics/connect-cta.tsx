import Link from 'next/link'
import type { ComponentType } from 'react'
import { ArrowRight } from 'lucide-react'

import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Shown instead of the dashboard when the channel has no connection.
 *
 * The distinction this preserves matters: an UNCONNECTED channel gets
 * this screen, while a connected channel with no traffic gets the real
 * dashboard with honest zeros. Collapsing the two would tell a
 * customer who connected last week and had a quiet week that they
 * never connected at all.
 */
export function ConnectCta({
  channelLabel,
  description,
  href,
  icon: Icon,
  accent,
  gradient,
}: {
  channelLabel: string
  description: string
  href: string
  icon: ComponentType<{ className?: string }>
  accent: string
  gradient?: string
}) {
  return (
    <div className="flex min-h-[24rem] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
      <span
        className="flex h-14 w-14 items-center justify-center rounded-2xl text-white"
        style={gradient ? { backgroundImage: gradient } : { backgroundColor: accent }}
      >
        <Icon className="h-7 w-7" />
      </span>
      <h2 className="mt-4 text-lg font-semibold text-foreground">
        Connect {channelLabel} to see analytics
      </h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>
      {/* Anchor styled with `buttonVariants` — this Button has no
          `asChild`, and an <a> inside a <button> is invalid markup. */}
      <Link href={href} className={cn(buttonVariants(), 'mt-5')}>
        Connect {channelLabel}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  )
}
