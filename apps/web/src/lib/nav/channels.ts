import type { ComponentType } from 'react';
import {
  BarChart3,
  Bot,
  Boxes,
  Calendar,
  FileText,
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
 * `conversations.channel` (migration 050) is what makes a channel real:
 * contacts, conversations and messages are shared across platforms and
 * discriminated by that column, with one config table per channel
 * (`whatsapp_config`, `instagram_config`).
 *
 * WhatsApp and Instagram are therefore `live`. Web and Phone remain
 * frames whose panel links all resolve to the connect screen — flipping
 * one to 'live' is what turns its panel into real routes, and should
 * only happen once it has a config table and a working inbound path.
 *
 * Not every panel row of a live channel has to exist yet: Instagram's
 * `[[...section]]` catch-all still backstops the rows that don't
 * (dm-agents, posts, intents), so adding a page is a pure addition.
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
}

/** A labelled group of panel rows ("Action", "Assets", "Analytics"). */
export interface PanelGroup {
  label: string | null;
  items: PanelItem[];
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
    ],
  },
];

const WEB_PANEL: PanelGroup[] = [
  {
    label: 'Action',
    items: [
      {
        id: 'web-settings',
        label: 'Channel Settings',
        icon: Settings,
        href: '/channels/web/settings',
      },
      {
        id: 'web-widget',
        label: 'Web Widget',
        icon: Sparkles,
        href: '/channels/web/widget',
      },
    ],
  },
  {
    label: 'Assets',
    items: [
      {
        id: 'web-knowledge',
        label: 'Knowledge Base',
        icon: Boxes,
        href: '/channels/web/knowledge',
      },
    ],
  },
  {
    label: 'Analytics',
    items: [
      {
        id: 'web-sessions',
        label: 'Sessions',
        icon: BarChart3,
        href: '/channels/web/sessions',
      },
    ],
  },
];

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
    status: 'placeholder',
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
