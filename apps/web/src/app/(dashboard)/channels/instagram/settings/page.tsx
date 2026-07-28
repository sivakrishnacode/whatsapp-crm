import { InstagramConfig } from '@/components/channels/instagram/instagram-config';

/**
 * Instagram channel settings — connect, connection health, and the
 * platform rules that differ from WhatsApp.
 *
 * Takes precedence over the sibling `[[...section]]` catch-all: a
 * concrete segment always beats an optional catch-all in Next's route
 * matching, so the remaining panel rows (dm-agents, posts, intents)
 * keep falling through to the connect screen until they get real pages.
 */
export default function InstagramChannelSettingsPage() {
  return <InstagramConfig />;
}
