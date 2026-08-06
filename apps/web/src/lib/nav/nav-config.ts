import {
  Bot,
  ClipboardList,
  GitBranch,
  Home,
  Inbox,
  PlugZap,
  Settings,
  Users,
  UsersRound,
  Zap,
} from 'lucide-react';

import {
  CHANNELS,
  CHANNEL_ORDER,
  channelBase,
  channelLandingHref,
  isChannelId,
  type ChannelDef,
  type ChannelId,
  type NavIcon,
  type PanelGroup,
  type PanelItem,
} from './channels';
import {
  RAIL_GROUPS as SETTINGS_RAIL_GROUPS,
  SECTION_META,
  SETTINGS_SECTIONS,
  resolveSection,
} from '@/components/settings/settings-sections';

/**
 * Primary-rail structure + the resolver that turns a pathname into
 * "which rail row is active, which second panel (if any) is open, and
 * what should the header say".
 *
 * Structure follows the reference product: no group *labels* in the
 * rail, just thin dividers between blocks — a search placeholder and
 * Onboarding up top, a workspace block, the channel block, then
 * Settings and the user card pinned to the bottom.
 *
 * This is the single source of truth for all three consumers (rail,
 * secondary panel, header breadcrumb). Adding a destination in one
 * place makes it navigable, highlightable and titled at once.
 */

/** Rail rows that are not channels. */
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
}

/**
 * The workspace block — between Onboarding and the channels.
 *
 * These are the surfaces that span every channel. Automations lives
 * here rather than in the WhatsApp panel because the engine is
 * channel-agnostic: a send step is routed by the conversation's own
 * channel, so one automation answers a WhatsApp message and an
 * Instagram DM without being authored twice. Filing it under a channel
 * implied a scope it does not have.
 */
export const RAIL_WORKSPACE: RailItem[] = [
  { id: 'home', label: 'Home', icon: Home, href: '/dashboard', exact: true },
  { id: 'inbox', label: 'Inbox', icon: Inbox, href: '/inbox', unreadDot: true },
  { id: 'contacts', label: 'Contacts', icon: Users, href: '/contacts' },
  { id: 'pipelines', label: 'Pipelines', icon: GitBranch, href: '/pipelines' },
  { id: 'automations', label: 'Automations', icon: Zap, href: '/automations' },
  { id: 'agents', label: 'AI Agents & Bots', icon: Bot, href: '/agents' },
];

/** Above the first divider, next to the search placeholder. */
export const RAIL_ONBOARDING: RailItem = {
  id: 'onboarding',
  label: 'Onboarding',
  icon: ClipboardList,
  href: '/onboarding',
};

/** Pinned to the bottom, above the user card. */
export const RAIL_BOTTOM: RailItem[] = [
  { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
];

/**
 * The Settings second panel.
 *
 * Derived from the existing settings IA (`SETTINGS_SECTIONS` /
 * `SECTION_META` / `RAIL_GROUPS`) rather than re-declared, so the two
 * can't drift — that module still owns which sections exist, their
 * labels, icons and `adminOnly` flags. We only add the rows for surfaces
 * that live on their own routes rather than behind `?tab=`.
 */
const SETTINGS_EXTRA_ROWS: Record<string, PanelItem[]> = {
  workspace: [
    { id: 'members', label: 'Users & Roles', icon: UsersRound, href: '/members' },
    // No "Subscriptions" row here. It used to point at a per-user
    // subscription list, which stopped making sense once a plan became
    // a property of the workspace rather than of each member: the page
    // showed a "Change Plan" button per teammate for a plan there is
    // only one of. Billing now lives in exactly one place —
    // Settings → Plan & billing.
  ],
  developer: [
    {
      id: 'integrations',
      label: 'Integrations',
      icon: PlugZap,
      href: '/integrations',
    },
  ],
};

function buildSettingsPanel(): PanelGroup[] {
  const groups: PanelGroup[] = SETTINGS_RAIL_GROUPS.map(({ label, group }) => ({
    label,
    items: SETTINGS_SECTIONS.filter((s) => SECTION_META[s].group === group).map((s) => {
      const meta = SECTION_META[s];
      return {
        id: `settings-${s}`,
        label: meta.label,
        icon: meta.icon,
        // The WhatsApp row is the pointer into the channel panel — one
        // source of truth for the connection form, which now lives at
        // its channel route.
        href:
          s === 'whatsapp'
            ? '/channels/whatsapp/settings'
            : `/settings?tab=${s}`,
        adminOnly: meta.adminOnly,
        ownerOnly: meta.ownerOnly,
      } satisfies PanelItem;
    }),
  }));

  // Splice the route-based rows into their groups.
  for (const g of groups) {
    const extras = g.label ? SETTINGS_EXTRA_ROWS[g.label.toLowerCase()] : undefined;
    if (extras) g.items = [...g.items, ...extras];
  }

  // `RAIL_GROUPS` has no "Developer" group today, so the extras keyed
  // under it need their own trailing group.
  groups.push({ label: 'Developer', items: SETTINGS_EXTRA_ROWS.developer });

  return groups.filter((g) => g.items.length > 0);
}

export const SETTINGS_PANEL: PanelGroup[] = buildSettingsPanel();

/** What the shell needs to render for a given pathname. */
export interface NavContext {
  /** Rail row id to highlight. */
  activeRailId: string | null;
  /** Channel whose panel is open, if any. */
  activeChannel: ChannelDef | null;
  /** Panel groups to render in the second sidebar; null hides it. */
  panel: PanelGroup[] | null;
  /** Panel header label ("WhatsApp", "Settings"). */
  panelTitle: string | null;
  /**
   * Panel row id to highlight. Resolved here rather than in the panel
   * component so the tie-breaking rules (`?tab=` siblings, legacy tab
   * aliases, flat routes surfaced inside a channel) live in one place.
   */
  activePanelItemId: string | null;
  /** Header page title. */
  title: string;
  /** Optional prefix shown before the title ("WhatsApp / Templates"). */
  breadcrumb: string | null;
}

/** Strip the query string — panel hrefs carry `?tab=`. */
function pathOf(href: string): string {
  const q = href.indexOf('?');
  return q === -1 ? href : href.slice(0, q);
}

function matches(pathname: string, href: string, exact = false): boolean {
  const path = pathOf(href);
  if (pathname === path) return true;
  if (exact) return false;
  return pathname.startsWith(`${path}/`);
}

/** Find the best-matching row in a set of panel groups. */
function findPanelItem(
  groups: PanelGroup[],
  pathname: string,
  search?: string,
): PanelItem | null {
  const candidates = groups
    .flatMap((g) => g.items)
    .filter((item) => {
      if (item.matchPaths?.some((p) => matches(pathname, p))) return true;
      return matches(pathname, item.href);
    });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Two rows can share a path and differ only by `?tab=` — Catalog and
  // Orders both live on /commerce. Prefer the one whose tab matches.
  const tab = search ? new URLSearchParams(search).get('tab') : null;
  if (tab) {
    const byTab = candidates.find((c) => c.href.includes(`tab=${tab}`));
    if (byTab) return byTab;
  }

  // No tab in the URL: the page itself falls back to its first tab
  // (commerce → catalogue), so the first candidate in panel order is the
  // one actually being shown.
  const sharePath = candidates.filter((c) => pathOf(c.href) === pathOf(candidates[0].href));
  if (sharePath.length > 1) return sharePath[0];

  // Otherwise the longest href wins — the most specific route.
  return candidates.reduce((best, c) =>
    pathOf(c.href).length > pathOf(best.href).length ? c : best,
  );
}

/**
 * Resolve the nav state for a pathname (+ optional query string, needed
 * to disambiguate `?tab=`-only siblings).
 */
export function resolveNavContext(pathname: string, search?: string): NavContext {
  const empty: NavContext = {
    activeRailId: null,
    activeChannel: null,
    panel: null,
    panelTitle: null,
    activePanelItemId: null,
    title: 'Dashboard',
    breadcrumb: null,
  };

  // 1. A channel URL, or a flat route surfaced inside a channel panel
  //    (Automations / Flows live on flat routes — see channels.ts).
  const segments = pathname.split('/').filter(Boolean);
  const urlChannel =
    segments[0] === 'channels' && isChannelId(segments[1])
      ? (segments[1] as ChannelId)
      : null;

  const channelId: ChannelId | null =
    urlChannel ??
    CHANNEL_ORDER.find((id) =>
      CHANNELS[id].panel.some((g) =>
        g.items.some((item) => item.matchPaths?.some((p) => matches(pathname, p))),
      ),
    ) ??
    null;

  if (channelId) {
    const channel = CHANNELS[channelId];
    // A locked channel has no panel and no routes; treat as unmatched.
    if (channel.status !== 'locked') {
      const item = findPanelItem(channel.panel, pathname, search);
      return {
        activeRailId: `channel-${channel.id}`,
        activeChannel: channel,
        panel: channel.panel,
        panelTitle: channel.label,
        activePanelItemId: item?.id ?? null,
        title: item?.label ?? channel.label,
        breadcrumb: item ? channel.label : null,
      };
    }
  }

  // 2. Settings — also gets a second panel. Includes the settings-owned
  //    surfaces that live on their own routes rather than behind `?tab=`.
  if (
    matches(pathname, '/settings') ||
    matches(pathname, '/members') ||
    matches(pathname, '/integrations')
  ) {
    // On /settings the tab is authoritative, and `resolveSection` already
    // owns the defaulting (bare /settings → overview) and the legacy
    // aliases (?tab=tags / ?tab=custom-fields → fields). Reuse it rather
    // than re-deriving the active row from the URL here.
    if (matches(pathname, '/settings')) {
      const section = resolveSection(
        search ? new URLSearchParams(search).get('tab') : null,
      );
      return {
        activeRailId: 'settings',
        activeChannel: null,
        panel: SETTINGS_PANEL,
        panelTitle: 'Settings',
        activePanelItemId: `settings-${section}`,
        title: SECTION_META[section].label,
        breadcrumb: 'Settings',
      };
    }

    // /members and /integrations — own routes, but they belong to the
    // Settings panel.
    const item = findPanelItem(SETTINGS_PANEL, pathname, search);
    return {
      activeRailId: 'settings',
      activeChannel: null,
      panel: SETTINGS_PANEL,
      panelTitle: 'Settings',
      activePanelItemId: item?.id ?? null,
      title: item?.label ?? 'Settings',
      breadcrumb: 'Settings',
    };
  }

  // 3. A plain rail destination — no second panel.
  const railItem =
    [RAIL_ONBOARDING, ...RAIL_WORKSPACE, ...RAIL_BOTTOM].find((i) =>
      matches(pathname, i.href, i.exact) ||
      i.matchPaths?.some((p) => matches(pathname, p)),
    ) ?? null;

  if (railItem) {
    return {
      ...empty,
      activeRailId: railItem.id,
      title: railItem.label,
    };
  }

  // 4. Routes with no rail row of their own (Notifications moved to the
  //    header bell; /pricing is reachable from the Settings panel as
  //    `?tab=pricing`) still need a sane header title.
  const UNLISTED_TITLES: Record<string, string> = {
    '/notifications': 'Notifications',
    '/pricing': 'Plan & billing',
  };
  const unlisted = Object.entries(UNLISTED_TITLES).find(([p]) => matches(pathname, p));
  if (unlisted) return { ...empty, title: unlisted[1] };

  return empty;
}

export { CHANNELS, CHANNEL_ORDER, channelBase, channelLandingHref, isChannelId };
export type { ChannelDef, ChannelId, NavIcon, PanelGroup, PanelItem };
