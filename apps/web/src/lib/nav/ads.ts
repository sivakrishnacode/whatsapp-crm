import {
  BarChart3,
  FileText,
  Megaphone,
  Plus,
  Settings,
  Target,
  UserPlus,
  Users,
} from 'lucide-react';

import type { PanelGroup, RailItem } from './channels';

/**
 * The Ads Manager rail row and its second-sidebar panel.
 *
 * Its own file for the same reason `channels.ts` and
 * `settings-sections.ts` are: whoever owns a panel owns the file that
 * declares it, so `nav-config.ts` stays a resolver rather than a
 * registry of everything.
 *
 * WHY THIS IS NOT A CHANNEL
 *   It would have been cheaper — `channels.ts` already gives any entry a
 *   rail row, a panel, a connect screen and a status pip for free. But a
 *   channel in this codebase means something specific: a value of
 *   `conversations.channel`, a place customer conversations arrive from,
 *   with its own config table and inbound path. Ads are an acquisition
 *   surface; the conversation a Click-to-WhatsApp ad produces arrives on
 *   the WhatsApp channel, which already exists. Filing ads as a channel
 *   would have put a non-conversation source into the discriminator
 *   every inbox query, channel filter and status pip reads from.
 *
 *   So instead a plain rail row gained the ability to own a panel —
 *   `RailItem.panel` in channels.ts — which is a smaller change than a
 *   fake channel and useful to any future rail row.
 */

/** Panel rows. `Overview` is first, so it is also the rail row's target. */
const ADS_PANEL: PanelGroup[] = [
  {
    label: 'Action',
    items: [
      {
        id: 'ads-overview',
        label: 'Overview',
        icon: BarChart3,
        href: '/ads',
      },
      {
        id: 'ads-create',
        label: 'Create Ad',
        icon: Plus,
        href: '/ads/create',
      },
      {
        id: 'ads-leads',
        label: 'Leads',
        icon: UserPlus,
        href: '/ads/leads',
      },
    ],
  },
  {
    label: 'Assets',
    items: [
      {
        id: 'ads-lead-forms',
        label: 'Lead Forms',
        icon: FileText,
        // "Lead Forms", not "Forms". `/forms` is this product's own
        // hosted web-form builder; a Meta instant form is rendered by
        // Facebook inside an ad and arrives through the lead webhook.
        // Same word, unrelated systems — naming both "Forms" would put
        // two different things one click apart.
        href: '/ads/lead-forms',
      },
      {
        id: 'ads-audiences',
        label: 'Audiences',
        icon: Users,
        href: '/ads/audiences',
      },
      {
        id: 'ads-events',
        label: 'Events',
        icon: Target,
        href: '/ads/events',
      },
    ],
  },
  {
    label: 'Configuration',
    items: [
      {
        id: 'ads-setup',
        label: 'Setup',
        icon: Settings,
        href: '/ads/setup',
      },
    ],
  },
];

/**
 * The rail row.
 *
 * `exact: false` (the default) is right here: every `/ads/*` sub-route
 * should keep the row lit and the panel open, and the panel resolver
 * picks the specific row.
 */
export const ADS_RAIL_ITEM: RailItem = {
  id: 'ads',
  label: 'Ads Manager',
  icon: Megaphone,
  href: '/ads',
  panel: ADS_PANEL,
  panelTitle: 'Ads Manager',
};

export { ADS_PANEL };

/**
 * Whether the surface is switched on for this deployment.
 *
 * Mirrors `ADS_MANAGER_ENABLED` on the API. Hiding the row is a
 * courtesy, NOT access control — `AdsEnabledGuard` 404s every `/ads/*`
 * endpoint independently, which is what actually gates the feature.
 *
 * Read at module scope rather than through a hook because
 * `NEXT_PUBLIC_*` values are inlined at build time and cannot change at
 * runtime; a hook would imply otherwise.
 */
export const ADS_ENABLED =
  process.env.NEXT_PUBLIC_ADS_MANAGER_ENABLED === 'true';
