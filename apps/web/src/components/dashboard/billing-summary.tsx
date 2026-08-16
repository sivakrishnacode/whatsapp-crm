'use client'

import Link from 'next/link'
import { ArrowRight, CreditCard, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/use-auth'
import { useAiCredits } from '@/hooks/use-ai-credits'
import { formatLimit, type UserSubscription } from '@/lib/subscription/plans'
import { Skeleton } from '@/components/dashboard/skeleton'

/**
 * Plan and billing standing, at a glance.
 *
 * ⚠️ OWNER-ONLY, and that is not a style choice. Settings → Plan &
 * billing is `ownerOnly` in `settings-sections.ts` — stricter than
 * `adminOnly`, which admins also pass — because an admin runs the
 * workspace but the owner is the one who pays for it. A summary of the
 * same facts on a page every teammate opens would quietly undo that.
 *
 * This is a SUMMARY, not a second billing surface: everything
 * actionable is one link away at `?tab=pricing`, which remains the only
 * place a plan can be changed. Nothing here writes.
 *
 * It costs no requests. `useAuth()` already loads the subscription for
 * the settings page and the onboarding gate, and `useAiCredits()` is
 * provided by the dashboard shell — so this renders from state the app
 * has already paid for.
 */

/** The one billing surface. See settings-sections.ts. */
const BILLING_HREF = '/settings?tab=pricing'

type Tone = 'ok' | 'warn' | 'danger'

interface Standing {
  label: string
  detail: string
  tone: Tone
}

const TONE_PILL: Record<Tone, string> = {
  ok: 'border-accent-green/30 bg-accent-green/10 text-accent-green',
  warn: 'border-accent-amber/30 bg-accent-amber/10 text-accent-amber',
  danger: 'border-accent-red/30 bg-accent-red/10 text-accent-red',
}

function shortDate(iso: string | null): string {
  if (!iso) return 'unknown'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Whole days from now until `iso`, floored at 0. Negative reads as lapsed. */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.ceil((then - Date.now()) / 86_400_000)
}

/**
 * The sentence under the plan name.
 *
 * `cancel_at_period_end` is checked BEFORE the plain active case: a
 * subscription set to cancel is still `active` right up to the period
 * end, and showing it as "Renews on…" is the one wording that would be
 * actively false.
 */
export function subscriptionStanding(sub: UserSubscription): Standing {
  if (sub.status === 'trial') {
    const left = daysUntil(sub.trial_end_at)
    if (left === null) return { label: 'Trial', detail: 'Free trial in progress', tone: 'ok' }
    if (left <= 0)
      return { label: 'Trial ended', detail: 'Choose a plan to keep sending', tone: 'danger' }
    return {
      label: 'Trial',
      detail: `${left} day${left === 1 ? '' : 's'} left · ends ${shortDate(sub.trial_end_at)}`,
      tone: left <= 3 ? 'warn' : 'ok',
    }
  }

  if (sub.status === 'active' && sub.cancel_at_period_end) {
    return {
      label: 'Cancelling',
      detail: `Access ends ${shortDate(sub.current_period_end)}`,
      tone: 'warn',
    }
  }

  switch (sub.status) {
    case 'active':
      return {
        label: 'Active',
        detail: sub.current_period_end
          ? `Renews ${shortDate(sub.current_period_end)}`
          : 'Subscription active',
        tone: 'ok',
      }
    case 'past_due':
      return {
        label: 'Payment due',
        detail: 'Update your payment method to avoid interruption',
        tone: 'danger',
      }
    case 'cancelled':
      return { label: 'Cancelled', detail: 'Choose a plan to continue', tone: 'danger' }
    case 'expired':
      return { label: 'Expired', detail: 'Choose a plan to continue', tone: 'danger' }
    default:
      return { label: sub.status, detail: '', tone: 'warn' }
  }
}

export function BillingSummary() {
  const { isOwner, subscription, subscriptionLoading } = useAuth()
  const { credits } = useAiCredits()

  // Not the owner: render nothing at all rather than a locked-looking
  // card. A teammate who cannot act on billing does not benefit from
  // being told it exists.
  if (!isOwner) return null

  if (subscriptionLoading) {
    return (
      <section className="rounded-xl border border-border bg-card px-5 py-4">
        <Skeleton className="h-10 w-full" />
      </section>
    )
  }

  if (!subscription) {
    return (
      <Shell>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">No active plan</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pick a plan to unlock sending, broadcasts and automations.
          </p>
        </div>
        <ManageLink label="Choose a plan" />
      </Shell>
    )
  }

  const standing = subscriptionStanding(subscription)

  return (
    <Shell>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <CreditCard className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">
              {subscription.plan_display_name}
            </p>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                TONE_PILL[standing.tone],
              )}
            >
              {standing.label}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{standing.detail}</p>
        </div>
      </div>

      {/* Plan ALLOWANCES, not usage. Usage against them is enforced
          server-side by `check_account_limit` and has no read endpoint
          today, so quoting a "used" figure here would mean inventing a
          second count that could disagree with the one that blocks. */}
      <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <Allowance label="Contacts" value={formatLimit(subscription.max_contacts)} />
        <Allowance label="Messages/mo" value={formatLimit(subscription.max_messages_monthly)} />
        <Allowance label="Seats" value={formatLimit(subscription.max_team_members)} />
      </dl>

      {/* Only on platform credits: a BYOK workspace is billed by its own
          provider, so it has no balance of ours to run out of. */}
      {credits?.credit_mode === 'platform' && (
        <span
          className={cn(
            'flex items-center gap-1.5 text-xs',
            credits.low ? 'text-accent-amber' : 'text-muted-foreground',
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span className="tabular-nums">{credits.balance.toLocaleString()}</span> AI credits
        </span>
      )}

      <ManageLink label="Manage plan" />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-border bg-card px-5 py-4">
      {children}
    </section>
  )
}

function Allowance({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt>{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

function ManageLink({ label }: { label: string }) {
  return (
    <Link
      href={BILLING_HREF}
      className="ml-auto flex items-center gap-1 text-xs font-medium text-primary hover:underline"
    >
      {label}
      <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  )
}
