'use client'

import Link from 'next/link'
import { Briefcase, Inbox, Radio, UserPlus, Zap } from 'lucide-react'
import type { ComponentType } from 'react'

import { cn } from '@/lib/utils'
import { useChannelStatus } from '@/hooks/use-channel-status'

/**
 * Quick-action shortcuts — a single compact row, not a tile grid.
 *
 * ⚠️ THE BAR IS "WOULD SOMEONE DO THIS MOST DAYS", NOT "IS THIS
 * IMPORTANT". Widget setup and comment funnels are configured once and
 * then left alone for months; giving them permanent tiles spent a third
 * of the first screen on links nobody clicks twice, and pushed the
 * charts below the fold. Setup lives on the channel cards below, which
 * is where someone goes when they are actually setting a channel up.
 *
 * Each link navigates to the page that owns the relevant "create" flow.
 * We deliberately don't try to auto-open any modal on the target page —
 * that'd require touching those pages, which is out of scope here.
 */
interface Action {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
}

/** Available on every workspace — these engines are channel-agnostic. */
const BASE_ACTIONS: Action[] = [
  { label: 'New contact', href: '/contacts', icon: UserPlus, tint: 'text-primary' },
  { label: 'New deal', href: '/pipelines', icon: Briefcase, tint: 'text-accent-blue' },
  { label: 'New automation', href: '/automations/new', icon: Zap, tint: 'text-primary' },
  { label: 'Open inbox', href: '/inbox', icon: Inbox, tint: 'text-accent-blue' },
]

/**
 * The one channel action that recurs. A broadcast is a campaign someone
 * sends again next week; Instagram's and Web's equivalents are both
 * one-time configuration, so they are reached from the channel card
 * rather than pinned here.
 *
 * Gated on a live WhatsApp connection: on an Instagram-only workspace
 * this is a shortcut to a page that cannot send anything.
 */
const BROADCAST: Action = {
  label: 'New broadcast',
  href: '/channels/whatsapp/broadcasts/new',
  icon: Radio,
  tint: 'text-accent-amber',
}

export function QuickActions() {
  const statuses = useChannelStatus()

  // Only 'connected' qualifies. 'loading' deliberately does not: a pill
  // appearing a second after the row settles shifts the ones beside it.
  const actions =
    statuses.whatsapp?.state === 'connected' ? [...BASE_ACTIONS, BROADCAST] : BASE_ACTIONS

  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-border hover:bg-muted/60"
          >
            <Icon className={cn('h-4 w-4 shrink-0', a.tint)} />
            {a.label}
          </Link>
        )
      })}
    </div>
  )
}
