/**
 * Per-channel presentation for the analytics pages: the accent that
 * tells you at a glance which channel you are looking at, the quick
 * actions in the header, and where each fix-it alert sends you.
 *
 * This is presentation only. `lib/nav/channels.ts` remains the channel
 * registry — labels, icons, status and the sidebar panel all come from
 * there, and nothing is duplicated here.
 */

import type { ComponentType } from 'react'
import {
  Bot,
  Calendar,
  FileText,
  Gift,
  Grid3x3,
  Inbox,
  LayoutTemplate,
  MessageCircle,
  Radio,
  Settings,
  ShoppingBag,
  Workflow,
} from 'lucide-react'

import type { AnalyticsChannel } from './types'

export interface QuickAction {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
}

export interface ChannelAnalyticsConfig {
  /**
   * Chart and accent colour. A literal hex rather than a theme token
   * because it is the BRAND's colour, not the app's — it must stay
   * WhatsApp green in both light and dark mode, where every `--accent-*`
   * token shifts.
   */
  accent: string
  /** Second series colour, for outgoing/secondary lines. */
  accentAlt: string
  /** Optional brand gradient for the page header glyph. */
  gradient?: string
  /** Where the connect screen lives when the channel is not set up. */
  connectHref: string
  quickActions: QuickAction[]
  /** Where each `get_channel_alerts` kind sends the user to fix it. */
  alertHref: Record<string, string>
}

const INBOX: QuickAction = { label: 'Open inbox', href: '/inbox', icon: Inbox }

export const CHANNEL_ANALYTICS: Record<AnalyticsChannel, ChannelAnalyticsConfig> = {
  whatsapp: {
    accent: '#25D366',
    accentAlt: '#0891b2',
    connectHref: '/channels/whatsapp/settings',
    quickActions: [
      { label: 'New broadcast', href: '/channels/whatsapp/broadcasts', icon: Radio },
      { label: 'Templates', href: '/channels/whatsapp/templates', icon: FileText },
      { label: 'Campaigns', href: '/channels/whatsapp/campaigns', icon: Calendar },
      { label: 'Build a flow', href: '/flows', icon: Workflow },
      INBOX,
    ],
    alertHref: {
      failed_messages: '/inbox',
      unread: '/inbox',
      ai_handoff: '/inbox',
      rejected_templates: '/channels/whatsapp/templates',
      token_expiring: '/channels/whatsapp/settings',
      quality_rating: '/channels/whatsapp/settings',
    },
  },
  instagram: {
    accent: '#E1306C',
    accentAlt: '#F58529',
    gradient: 'linear-gradient(135deg, #F58529, #DD2A7B, #8134AF)',
    connectHref: '/channels/instagram/settings',
    quickActions: [
      { label: 'Comment funnels', href: '/channels/instagram/funnels', icon: Gift },
      { label: 'DM agents', href: '/channels/instagram/dm-agents', icon: Bot },
      { label: 'Posts', href: '/channels/instagram/posts', icon: Grid3x3 },
      { label: 'Comments', href: '/channels/instagram/comments', icon: MessageCircle },
      INBOX,
    ],
    alertHref: {
      failed_messages: '/inbox',
      unread: '/inbox',
      ai_handoff: '/inbox',
      connection: '/channels/instagram/settings',
      funnel_failures: '/channels/instagram/funnels',
    },
  },
  web: {
    accent: '#2D7FF9',
    accentAlt: '#8134AF',
    connectHref: '/channels/web/settings',
    quickActions: [
      { label: 'Widget setup', href: '/channels/web/widget', icon: LayoutTemplate },
      { label: 'Sessions', href: '/channels/web/sessions', icon: Grid3x3 },
      { label: 'Behaviour', href: '/channels/web/behaviour', icon: Settings },
      { label: 'Forms', href: '/forms', icon: ShoppingBag },
      INBOX,
    ],
    alertHref: {
      failed_messages: '/inbox',
      unread: '/inbox',
      ai_handoff: '/inbox',
      no_origins: '/channels/web/settings',
    },
  },
}

/**
 * Alert copy. The RPC returns a `kind`, a count and a short detail
 * fragment; the sentence is assembled here so wording changes do not
 * need a migration.
 */
export function alertSentence(kind: string, count: number, detail: string | null): string {
  const n = count.toLocaleString()
  switch (kind) {
    case 'failed_messages':
      return `${n} message${count === 1 ? '' : 's'} failed to send`
    case 'unread':
      return `${n} unread conversation${count === 1 ? '' : 's'}`
    case 'ai_handoff':
      return `${n} thread${count === 1 ? '' : 's'} handed over by the AI agent`
    case 'rejected_templates':
      return `${n} template${count === 1 ? '' : 's'} rejected by Meta`
    case 'token_expiring':
      return 'WhatsApp access token expires within 14 days'
    case 'quality_rating':
      return `WhatsApp quality rating is ${(detail ?? '').toLowerCase()}`
    case 'connection':
      return 'Instagram needs reconnecting'
    case 'funnel_failures':
      return `${n} comment-funnel run${count === 1 ? '' : 's'} failed`
    case 'no_origins':
      return 'No allowed origins — the widget is blocked on every site'
    default:
      return detail ?? kind
  }
}

export function alertActionLabel(kind: string): string {
  switch (kind) {
    case 'failed_messages':
    case 'unread':
    case 'ai_handoff':
      return 'Open inbox'
    case 'rejected_templates':
      return 'Review templates'
    case 'token_expiring':
    case 'connection':
    case 'no_origins':
      return 'Fix in settings'
    case 'quality_rating':
      return 'View channel'
    case 'funnel_failures':
      return 'Review funnels'
    default:
      return 'Open'
  }
}
