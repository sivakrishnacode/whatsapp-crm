/**
 * Which automations belong on the Instagram Intents page.
 *
 * Kept out of the component so the rule can be tested — getting this
 * wrong is silent in both directions: too strict and a working rule
 * looks missing, too loose and the page promises behaviour the engine
 * will not deliver.
 */

export interface ChannelScoped {
  /** Empty = every channel. Non-empty restricts. See migration 052. */
  channels?: string[] | null;
}

/**
 * Does this rule reach Instagram at all?
 *
 * `automations.channels` is a restriction list where EMPTY MEANS ALL
 * (migration 052) — so an unscoped automation does run on Instagram and
 * belongs here, while one scoped to `['web']` can never fire on
 * Instagram no matter what its keywords say.
 *
 * Deliberately mirrors what AutomationDispatchService does at dispatch
 * time. Listing a rule the engine would skip is worse than not listing
 * it: the page becomes a promise the runtime doesn't keep, and the first
 * sign of trouble is a customer who never got a reply.
 */
export function runsOnInstagram(automation: ChannelScoped): boolean {
  const channels = automation.channels ?? [];
  return channels.length === 0 || channels.includes('instagram');
}

/** How a rule's channel scope reads on the row. */
export function channelScopeLabel(
  channels: string[] | null | undefined
): string {
  const list = channels ?? [];
  if (list.length === 0) return 'All channels';
  if (list.length === 1 && list[0] === 'instagram') return 'Instagram only';
  return list
    .map((channel) => channel.charAt(0).toUpperCase() + channel.slice(1))
    .join(' + ');
}
