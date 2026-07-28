import { InstagramIntents } from '@/components/channels/instagram/instagram-intents';

/**
 * Keyword intents — a view over the shared Automations engine, scoped
 * to `keyword_match` rules. Creating and editing happens in the
 * Automations builder; this page frames them for Instagram, where they
 * match comments as well as DMs.
 */
export default function InstagramIntentsPage() {
  return <InstagramIntents />;
}
