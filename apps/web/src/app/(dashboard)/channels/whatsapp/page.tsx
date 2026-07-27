import { redirect } from 'next/navigation';

import { channelLandingHref } from '@/lib/nav/channels';

/**
 * `/channels/whatsapp` has no content of its own — it's a namespace root.
 * Without this page it 404s, which is what a hand-typed or bookmarked
 * channel URL would hit (the placeholder channels don't have the problem
 * because their optional catch-all matches the root as well).
 *
 * Sends visitors to the same place the rail's WhatsApp row goes.
 */
export default function WhatsAppChannelIndex() {
  redirect(channelLandingHref('whatsapp'));
}
