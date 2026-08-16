'use client'

import Link from 'next/link'
import { Briefcase, Gift, Inbox, Radio, Sparkles, UserPlus, Zap } from 'lucide-react'
import type { ComponentType } from 'react'

import { useChannelStatus } from '@/hooks/use-channel-status'
import { CHANNEL_ORDER, type ChannelId } from '@/lib/nav/channels'

/**
 * Quick-action shortcuts. Each navigates to the page that owns the
 * relevant "create" flow. We deliberately don't try to auto-open any
 * modal on the target page — that'd require touching those pages,
 * which is out of scope here.
 *
 * ⚠️ THE CHANNEL ROWS ARE GATED ON A LIVE CONNECTION. "New broadcast"
 * used to be a permanent tile pointing at WhatsApp regardless, which on
 * an Instagram-only workspace was a shortcut to a page that cannot send
 * anything — and made the whole dashboard read as a WhatsApp product.
 * A shortcut to something you cannot do is worse than no shortcut.
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
 * One extra action per connected channel — the thing you most often
 * come to that channel to start. Phone has none: it is locked, so it
 * never reports `connected` and never reaches this map.
 */
const CHANNEL_ACTIONS: Partial<Record<ChannelId, Action>> = {
  whatsapp: {
    label: 'New broadcast',
    href: '/channels/whatsapp/broadcasts/new',
    icon: Radio,
    tint: 'text-accent-amber',
  },
  instagram: {
    label: 'Comment funnel',
    href: '/channels/instagram/funnels',
    icon: Gift,
    tint: 'text-accent-amber',
  },
  web: {
    label: 'Widget setup',
    href: '/channels/web/widget',
    icon: Sparkles,
    tint: 'text-accent-blue',
  },
}

export function QuickActions() {
  const statuses = useChannelStatus()

  const actions: Action[] = [
    ...BASE_ACTIONS,
    ...CHANNEL_ORDER.flatMap((id) => {
      // Only 'connected' qualifies. 'loading' deliberately does not:
      // tiles appearing a second after the page settles is a worse
      // flicker than one arriving late.
      if (statuses[id]?.state !== 'connected') return []
      const action = CHANNEL_ACTIONS[id]
      return action ? [action] : []
    }),
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {actions.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-border hover:bg-muted/60"
          >
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg bg-muted ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-foreground">{a.label}</span>
          </Link>
        )
      })}
    </div>
  )
}
