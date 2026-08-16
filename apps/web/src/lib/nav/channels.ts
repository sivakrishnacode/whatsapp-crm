import type { ComponentType } from 'react';
import {
  BarChart3,
  Bot,
  Calendar,
  Clock,
  FileText,
  Gift,
  Globe,
  Grid3x3,
  Heart,
  LayoutTemplate,
  Megaphone,
  MessageCircle,
  Phone,
  Radio,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  Workflow,
} from 'lucide-react';

import { InstagramIcon, WhatsAppIcon } from '@/components/channels/channel-icons';

/**
 * Icon shape shared by every nav surface.
 *
 * Deliberately looser than `LucideIcon`: lucide-react 1.x dropped its
 * brand icons, so WhatsApp and Instagram are hand-rolled SVGs (see
 * components/channels/channel-icons.tsx). All the nav ever does is render
 * them with a `className`, so that is all the contract needs to promise —
 * and every lucide icon satisfies it.
 */
export type NavIcon = ComponentType<{ className?: string }>;

/**
 * Channel registry — the one place that knows what platforms this CRM
 * speaks and what each one's second-sidebar panel contains.
 *
 * Adding a channel is a single entry here: the primary rail, the
 * secondary panel, the header breadcrumb, the connect screen and the
 * onboarding checklist all read from this file, so none of them need
 * touching.
 *
 * `conversations.channel` (migrations 050 and 053) is what makes a
 * channel real: contacts, conversations and messages are shared across
 * platforms and discriminated by that column, with one config table per
 * channel (`whatsapp_config`, `instagram_config`, `web_config`).
 *
 * WhatsApp, Instagram and Web are therefore `live`. Phone remains a
 * frame whose panel links all resolve to the connect screen — flipping
 * one to 'live' is what turns its panel into real routes, and should
 * only happen once it has a config table and a working inbound path.
 *
 * Not every panel row of a live channel has to exist yet: the
 * `[[...section]]` catch-alls still backstop the rows that don't
 * (Instagram's dm-agents/posts/intents), so adding a page is a pure
 * addition. That backstop only covers routes inside the channel's own URL
 * space — a panel row pointing at a flat route must not be listed before
 * that route exists, because nothing catches it.
 */

/** Stable ids. Also the URL segment under `/channels/<id>`. */
export const CHANNEL_IDS = ['whatsapp', 'instagram', 'web', 'phone'] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

export type ChannelStatusKind =
  /** Fully implemented — panel links go to real pages. */
  | 'live'
  /** Reachable, but every panel link lands on the connect screen. */
  | 'placeholder'
  /** Not reachable at all — dimmed rail row, no route, no panel. */
  | 'locked';

/** One row inside a second-sidebar panel. */
export interface PanelItem {
  id: string;
  label: string;
  icon: NavIcon;
  href: string;
  /**
   * Extra paths that should light this row up and keep its panel open.
   * Used where a panel row points at a route that lives outside the
   * channel's own URL space — Automations and Flows are shared engines
   * on flat routes, surfaced inside the WhatsApp panel.
   */
  matchPaths?: string[];
  /** Hidden from non-admins. Mirrors `SectionMeta.adminOnly`. */
  adminOnly?: boolean;
  /**
   * Hidden from everyone but the account owner — stricter than
   * `adminOnly`, which admins also pass. For billing: an admin runs the
   * workspace, but the owner is the one who pays for it.
   */
  ownerOnly?: boolean;
}

/** A labelled group of panel rows ("Action", "Assets", "Analytics"). */
export interface PanelGroup {
  label: string | null;
  items: PanelItem[];
}

/**
 * A primary-rail row that is not a channel.
 *
 * Lives here rather than in nav-config.ts so it can reference
 * `PanelGroup` without an import cycle — `ads.ts` needs both, and
 * nav-config.ts imports from both.
 */
export interface RailItem {
  id: string;
  label: string;
  icon: NavIcon;
  href: string;
  /** Extra prefixes that should mark this row active. */
  matchPaths?: string[];
  /**
   * When true the row only highlights on an exact pathname match.
   * `/dashboard` needs this — `startsWith` would otherwise light Home up
   * for every route beginning with it.
   */
  exact?: boolean;
  /** Show the unread-conversations dot (Inbox). */
  unreadDot?: boolean;
  /**
   * Second-sidebar panel this row owns.
   *
   * Until Ads Manager, only a channel or Settings could own a panel and
   * both were special-cased in `resolveNavContext`. Generalising it to
   * any rail row was smaller than adding a third special case, and
   * avoided the alternative — registering Ads as a fake channel, which
   * would have polluted `conversations.channel` semantics for a surface
   * no conversation ever arrives on.
   *
   * A row with a panel still behaves like a plain rail destination in
   * every other respect; `href` should point at the panel's first row.
   */
  panel?: PanelGroup[];
  /** Panel header label. Required in practice whenever `panel` is set. */
  panelTitle?: string;
}

export interface ChannelDef {
  id: ChannelId;
  /** Rail + panel header label. */
  label: string;
  icon: NavIcon;
  status: ChannelStatusKind;
  /**
   * Brand colour for the rail icon. The reference renders channel icons
   * in brand colours rather than `currentColor`, which is what makes the
   * channel block read as a distinct group.
   */
  accentClass: string;
  /** Copy for the connect screen and the onboarding checklist. */
  tagline: string;
  /**
   * Soft brand wash behind the connect screen's artwork panel.
   *
   * Deliberately built from *translucent* brand colour rather than a
   * `light → dark:` pair: this app switches modes via
   * `html[data-mode="dark"]` and never applies a `.dark` class, but the
   * `dark:` variant is defined as `&:is(.dark *)` — so `dark:*` utilities
   * never activate here. An alpha wash composites over whatever
   * `--background` resolves to and is therefore correct in both modes.
   */
  connectArtClass: string;
  panel: PanelGroup[];
}

const CHANNELS_BASE = '/channels';

/** `/channels/<id>` — a channel's URL namespace root. */
export function channelBase(id: ChannelId): string {
  return `${CHANNELS_BASE}/${id}`;
}

/**
 * Where a channel's rail row should navigate to.
 *
 * The namespace root itself is NOT a valid destination for a live
 * channel: `/channels/whatsapp` has no `page.tsx` (only subdirectories),
 * so linking there 404s. Placeholder channels get away with it only
 * because their optional catch-all matches the root too — a difference
 * that's invisible until you click it.
 *
 * So the landing page is the channel's first panel row, which is the one
 * a user would pick anyway (Channel Settings for all three). Deriving it
 * keeps the rail correct automatically as panels change, instead of
 * relying on a hardcoded href staying in sync.
 */
export function channelLandingHref(id: ChannelId): string {
  const first = CHANNELS[id].panel[0]?.items[0]?.href;
  return first ?? channelBase(id);
}

const WHATSAPP_PANEL: PanelGroup[] = [
  {
    label: 'Action',
    items: [
      {
        id: 'wa-settings',
        label: 'Channel Settings',
        icon: Settings,
        href: '/channels/whatsapp/settings',
      },
      // Automations used to sit here as a flat route surfaced inside
      // the WhatsApp panel. It moved to the primary rail
      // (RAIL_WORKSPACE) once the engine became channel-agnostic:
      // ChannelSenderService routes a send step by the conversation's
      // channel, so one automation runs on WhatsApp and Instagram
      // alike. Filing it under WhatsApp implied it was WhatsApp-only.
      {
        id: 'wa-flows',
        label: 'Flows',
        icon: Workflow,
        // Shared engine on a flat route — see `matchPaths` docs above.
        href: '/flows',
        matchPaths: ['/flows'],
      },
      {
        id: 'wa-broadcasts',
        label: 'Broadcasts',
        icon: Radio,
        href: '/channels/whatsapp/broadcasts',
      },
      {
        id: 'wa-campaigns',
        label: 'Campaigns',
        icon: Calendar,
        href: '/channels/whatsapp/campaigns',
      },
    ],
  },
  {
    label: 'Assets',
    items: [
      {
        id: 'wa-templates',
        label: 'Templates',
        icon: FileText,
        href: '/channels/whatsapp/templates',
      },
      {
        id: 'wa-wa-flows',
        label: 'WhatsApp Flows',
        icon: LayoutTemplate,
        href: '/channels/whatsapp/flows',
      },
      {
        id: 'wa-catalog',
        label: 'Catalog',
        icon: ShoppingBag,
        href: '/channels/whatsapp/commerce?tab=catalogue',
      },
    ],
  },
  {
    label: 'Analytics',
    items: [
      // Overview leads the group: it is the page that answers "how is
      // this channel doing", and the two below it answer narrower
      // questions that the overview links into.
      {
        id: 'wa-analytics',
        label: 'Overview',
        icon: TrendingUp,
        href: '/channels/whatsapp/analytics',
      },
      {
        id: 'wa-ctwa',
        label: 'Click-to-WhatsApp',
        icon: Megaphone,
        href: '/channels/whatsapp/ctwa',
      },
      {
        id: 'wa-orders',
        label: 'Orders',
        icon: ShoppingCart,
        href: '/channels/whatsapp/commerce?tab=orders',
      },
    ],
  },
];

const INSTAGRAM_PANEL: PanelGroup[] = [
  {
    label: 'Action',
    items: [
      {
        id: 'ig-settings',
        label: 'Channel Settings',
        icon: Settings,
        href: '/channels/instagram/settings',
      },
      {
        id: 'ig-dm-agents',
        label: 'DM Agents',
        icon: Bot,
        href: '/channels/instagram/dm-agents',
      },
    ],
  },
  {
    label: 'Assets',
    items: [
      {
        id: 'ig-posts',
        label: 'Posts',
        icon: Grid3x3,
        href: '/channels/instagram/posts',
      },
      {
        id: 'ig-comments',
        label: 'Comments',
        icon: MessageCircle,
        href: '/channels/instagram/comments',
      },
      {
        id: 'ig-intents',
        label: 'Intents',
        icon: Heart,
        href: '/channels/instagram/intents',
      },
      {
        id: 'ig-funnels',
        label: 'Comment Funnels',
        icon: Gift,
        href: '/channels/instagram/funnels',
      },
    ],
  },
  {
    label: 'Analytics',
    items: [
      {
        id: 'ig-analytics',
        label: 'Overview',
        icon: TrendingUp,
        href: '/channels/instagram/analytics',
      },
    ],
  },
];

const WEB_PANEL: PanelGroup[] = [
  {
    label: 'Setup',
    items: [
      {
        id: 'web-settings',
        label: 'Channel Settings',
        icon: Settings,
        href: '/channels/web/settings',
      },
    ],
  },
  {
    /*
     * The widget and forms are two different products that happen to
     * share a channel, so they get a group each.
     *
     * They were one "Action" list, which read as four unrelated rows and
     * gave no hint that Behaviour belongs to the widget rather than to
     * forms — it configures the widget's pre-chat, business hours and
     * offline message, which is exactly the thing a reader has to guess
     * from a flat list.
     */
    label: 'Chat widget',
    items: [
      {
        id: 'web-widget',
        label: 'Web Widget',
        icon: Sparkles,
        href: '/channels/web/widget',
      },
      {
        id: 'web-behaviour',
        label: 'Behaviour',
        icon: Clock,
        href: '/channels/web/behaviour',
      },
    ],
  },
  {
    label: 'Forms & bookings',
    items: [
      {
        id: 'web-forms',
        label: 'Forms',
        icon: FileText,
        // Channel-agnostic flat route surfaced in the Web panel because
        // hosted forms and booking pages are the two things most often
        // built alongside a website widget. `matchPaths` lights this row
        // for any /forms sub-route (builder, submissions, etc.) so the
        // panel stays open while the user is working on a form.
        //
        // Appointments used to sit next to this row as its own section. It
        // was removed: booking IS a form — a form carrying a slot-picker
        // field — so a separate top-level Appointments surface meant two
        // half-built ways to collect the same thing, with two field
        // systems and two submission paths that would drift.
        href: '/forms',
        matchPaths: ['/forms'],
      },
    ],
  },
  {
    label: 'Analytics',
    items: [
      {
        id: 'web-analytics',
        label: 'Overview',
        icon: TrendingUp,
        href: '/channels/web/analytics',
      },
      {
        id: 'web-sessions',
        label: 'Sessions',
        icon: BarChart3,
        href: '/channels/web/sessions',
      },
    ],
  },
];

/*
 * Knowledge Base used to sit here under "Assets", pointing at `/agents`.
 *
 * Removed rather than moved: it was never a web thing. One corpus answers
 * WhatsApp, Instagram and web alike, `/agents` is already a primary-rail
 * destination in its own right, and a row that leaves the channel it
 * appears in is a navigation dead end — you land somewhere the panel
 * cannot highlight. AI Agents & Bots on the rail is the honest route.
 */

export const CHANNELS: Record<ChannelId, ChannelDef> = {
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: WhatsAppIcon,
    status: 'live',
    accentClass: 'text-[#25D366]',
    tagline: 'Connect channel to start receiving customer messages.',
    connectArtClass: 'bg-linear-to-br from-[#25D366]/20 to-[#25D366]/5',
    panel: WHATSAPP_PANEL,
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    icon: InstagramIcon,
    status: 'live',
    // The glyph paints its own brand gradient, so this accent only
    // applies where the icon is swapped for a lucide fallback.
    accentClass: 'text-[#E1306C]',
    tagline:
      'Let AI auto-reply to every comment and DM, follow up automatically, and segment responses by intent.',
    connectArtClass: 'bg-linear-to-br from-[#F58529]/20 to-[#E1306C]/10',
    panel: INSTAGRAM_PANEL,
  },
  web: {
    id: 'web',
    label: 'Web',
    icon: Globe,
    status: 'live',
    accentClass: 'text-[#2D7FF9]',
    tagline:
      'Put an AI agent on your website to greet visitors, answer questions, and capture leads.',
    connectArtClass: 'bg-linear-to-br from-[#2D7FF9]/20 to-[#2D7FF9]/5',
    panel: WEB_PANEL,
  },
  phone: {
    id: 'phone',
    label: 'Phone',
    icon: Phone,
    // Locked: rail row renders dimmed with a "Coming soon" tooltip and
    // no href, so the empty panel below is never reachable.
    status: 'locked',
    accentClass: 'text-[#8B5CF6]',
    tagline: 'Voice calling is coming soon.',
    connectArtClass: 'bg-linear-to-br from-[#8B5CF6]/20 to-[#8B5CF6]/5',
    panel: [],
  },
};

/** Rail order for the channel block. */
export const CHANNEL_ORDER: ChannelId[] = ['whatsapp', 'instagram', 'web', 'phone'];

export function isChannelId(value: string | undefined | null): value is ChannelId {
  return !!value && (CHANNEL_IDS as readonly string[]).includes(value);
}

/**
 * Human label for a channel URL's first segment — `('instagram', 'posts')`
 * → `'Posts'`. Lets the placeholder connect screens name the section the
 * user clicked without hardcoding a second copy of the panel labels.
 * Returns undefined for the channel root or an unknown segment.
 */
export function panelSectionLabel(
  channelId: ChannelId,
  segment: string | undefined,
): string | undefined {
  if (!segment) return undefined;
  const target = `${channelBase(channelId)}/${segment}`;
  for (const group of CHANNELS[channelId].panel) {
    const hit = group.items.find((item) => item.href === target);
    if (hit) return hit.label;
  }
  return undefined;
}
