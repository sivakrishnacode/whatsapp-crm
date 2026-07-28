import { redirect } from 'next/navigation';

import { channelLandingHref } from '@/lib/nav/channels';

/**
 * `/channels/instagram` and any unrecognised segment beneath it.
 *
 * Every panel row now has a real page (settings, dm-agents, posts,
 * comments, intents), and a concrete segment always beats an optional
 * catch-all in Next's route matching — so this only ever handles the
 * namespace root and typo'd URLs.
 *
 * It used to render the "Connect to Instagram" screen, which became
 * actively wrong once the channel shipped: a *connected* account
 * hitting a bookmarked or mistyped URL was told to connect something it
 * had already connected. Redirecting to the channel's landing page is
 * correct in both states — the settings page shows the connect prompt
 * when there genuinely is no connection, and the live status otherwise.
 *
 * Mirrors how `/channels/whatsapp` handles its namespace root.
 */
export default function InstagramChannelIndex() {
  redirect(channelLandingHref('instagram'));
}
