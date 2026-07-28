import { InstagramDmAgents } from '@/components/channels/instagram/instagram-dm-agents';

/**
 * Which agent answers an Instagram DM, and in what order.
 *
 * Not a second AI setup screen — the assistant is account-level and
 * shared with WhatsApp. This surfaces what is switched on, the order
 * the engines are consulted in, and the Instagram-specific rules that
 * change how they behave.
 */
export default function InstagramDmAgentsPage() {
  return <InstagramDmAgents />;
}
