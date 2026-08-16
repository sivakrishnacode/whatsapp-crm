import {
  CircleQuestionMark,
  ClipboardList,
  Globe,
  Megaphone,
  Terminal,
  Upload,
  UserPlus,
} from 'lucide-react';
import type { ContactSource } from '@/types';
import type { NavIcon } from '@/lib/nav/channels';
import {
  FacebookIcon,
  InstagramIcon,
  WhatsAppIcon,
} from '@/components/channels/channel-icons';

/**
 * How to present `contacts.source` — the record of where a contact first
 * entered the account (migration 056).
 *
 * WHY THE LABELS ARE PHRASED AS ACTIONS
 *   The raw values are engineering words ('api', 'broadcast',
 *   'facebook_lead'). What the person reading the contacts table wants
 *   to know is how this lead reached them, so each label answers that
 *   ("Added manually", "WhatsApp message", "Broadcast audience") and
 *   `description` carries the fuller explanation for the cases nobody
 *   can guess — those go in a `title` so the table stays scannable.
 *
 * WHY COLOUR LIVES ON THE ICON, NOT THE PILL
 *   Brand colours read as brand colours at icon size but fail contrast
 *   as small text — #25D366 on white is roughly 2:1. So the pill is
 *   neutral (theme tokens, correct in both modes) and only the glyph is
 *   tinted. This is the same split the channel rail uses: coloured icon,
 *   neutral label.
 *
 *   Note that no `dark:` utility can be used here. This app switches
 *   modes with `html[data-mode="dark"]` while Tailwind's `dark:` variant
 *   is defined as `&:is(.dark *)` (globals.css), so `dark:` never fires
 *   — see the long note on `connectArtClass` in lib/nav/channels.ts.
 */
export interface ContactSourceMeta {
  label: string;
  icon: NavIcon;
  /** Brand tint for the glyph only. Neutral token where there is no brand. */
  iconClass: string;
  /** Shown as a `title` — for the values a reader cannot infer. */
  description: string;
}

export const CONTACT_SOURCE_META: Record<ContactSource, ContactSourceMeta> = {
  manual: {
    label: 'Added manually',
    icon: UserPlus,
    iconClass: 'text-muted-foreground',
    description: 'Typed into the contact form by someone on your team.',
  },
  import: {
    label: 'Imported',
    icon: Upload,
    iconClass: 'text-muted-foreground',
    description: 'Came in through a CSV import.',
  },
  whatsapp: {
    label: 'WhatsApp',
    icon: WhatsAppIcon,
    // Inert: WhatsAppIcon is the official raster logo and cannot be
    // tinted. Left empty rather than carrying a hex that does nothing.
    iconClass: '',
    description:
      'Messaged your WhatsApp number first. Includes people who arrived from a click-to-WhatsApp ad.',
  },
  instagram: {
    label: 'Instagram',
    icon: InstagramIcon,
    // Inert, as above — the official logo paints its own gradient.
    iconClass: '',
    description: 'Sent your account an Instagram DM.',
  },
  web: {
    label: 'Website chat',
    icon: Globe,
    iconClass: 'text-[#2D7FF9]',
    description: 'Started a conversation in the chat widget on your site.',
  },
  form: {
    label: 'Form',
    icon: ClipboardList,
    iconClass: 'text-[#8B5CF6]',
    description: 'Submitted one of your forms, or booked a slot.',
  },
  facebook_lead: {
    label: 'Facebook lead',
    icon: FacebookIcon,
    iconClass: 'text-[#1877F2]',
    description: 'Filled in a Facebook lead-generation form.',
  },
  api: {
    label: 'API',
    icon: Terminal,
    iconClass: 'text-muted-foreground',
    description:
      'Created through the public API — either directly, or by sending them a message.',
  },
  broadcast: {
    label: 'Broadcast audience',
    icon: Megaphone,
    iconClass: 'text-[#F59E0B]',
    description:
      'A number pasted into a broadcast audience that was not yet a contact.',
  },
  unknown: {
    label: 'Unknown',
    icon: CircleQuestionMark,
    iconClass: 'text-muted-foreground',
    description:
      'This contact predates origin tracking. Origin cannot be recovered after the fact, so it was left blank rather than guessed.',
  },
};

/**
 * Resolve a possibly-absent or unrecognised value to something
 * renderable.
 *
 * Absent is treated as `'unknown'` rather than as an error: rows reach
 * the UI from select projections written before the column existed, and
 * a missing column is exactly as informative as a stored 'unknown'. A
 * value the DB accepted but this build does not know about (constraint
 * widened ahead of a deploy) lands here too.
 */
export function contactSourceMeta(
  source: ContactSource | string | null | undefined,
): ContactSourceMeta {
  if (!source) return CONTACT_SOURCE_META.unknown;
  return (
    CONTACT_SOURCE_META[source as ContactSource] ??
    CONTACT_SOURCE_META.unknown
  );
}
