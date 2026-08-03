import { InstagramFunnels } from '@/components/channels/instagram/instagram-funnels';

/**
 * Comment → DM funnels: someone comments on a post, and gets the link
 * in their DMs, optionally after being asked to follow.
 *
 * Its own page rather than a tab under Intents, because it is a
 * different engine. Intents are a view over the shared Automations
 * engine, which dispatches on a *contact* — and the people this feature
 * exists for have never messaged the business, so they have no contact
 * row for an automation to fire on.
 */
export default function InstagramFunnelsPage() {
  return <InstagramFunnels />;
}
