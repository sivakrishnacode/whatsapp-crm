import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  label: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'New Message',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-accent-blue',
  },
  first_inbound_message: {
    label: 'First Message from Contact',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-accent-teal',
  },
  keyword_match: {
    label: 'Keyword Match',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-accent-purple',
  },
  new_contact_created: {
    label: 'New Contact',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    label: 'Conversation Assigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-accent-cyan',
  },
  tag_added: {
    label: 'Tag Added',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-accent-amber',
  },
  time_based: {
    label: 'Time-Based',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
  instagram_comment: {
    label: 'Instagram Comment',
    pillClass: 'border-pink-500/30 bg-pink-500/10 text-accent-pink',
  },
  instagram_story_reply: {
    label: 'Instagram Story Reply',
    pillClass: 'border-orange-500/30 bg-orange-500/10 text-accent-orange',
  },
  web_chat_started: {
    label: 'Web Chat Started',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-accent-blue',
  },
  form_submitted: {
    label: 'Form Submitted',
    pillClass: 'border-violet-500/30 bg-violet-500/10 text-accent-violet',
  },
  appointment_booked: {
    label: 'Appointment Booked',
    pillClass: 'border-green-500/30 bg-green-500/10 text-accent-green',
  },
  appointment_cancelled: {
    label: 'Appointment Cancelled',
    pillClass: 'border-red-500/30 bg-red-500/10 text-accent-red',
  },
  appointment_rescheduled: {
    label: 'Appointment Rescheduled',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-accent-amber',
  },
}

export function triggerMeta(
  t: AutomationTriggerType | string,
  config?: unknown,
): TriggerMeta {
  const base =
    TRIGGER_META[t as AutomationTriggerType] ?? {
      label: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }

  if (config && typeof config === 'object') {
    const keywords = (config as { keywords?: string[] })?.keywords
    if (Array.isArray(keywords) && keywords.length > 0) {
      const filtered = keywords.filter((k) => typeof k === 'string' && k.trim().length > 0)
      if (filtered.length > 0) {
        return {
          ...base,
          label: `${base.label}: ${filtered.join(', ')}`,
        }
      }
    }
  }

  return base
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 2_592_000) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}
