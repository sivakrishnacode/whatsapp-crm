import { ChannelConnectScreen } from '@/components/channels/channel-connect-screen';
import { panelSectionLabel } from '@/lib/nav/channels';

/**
 * Instagram — every panel row resolves here until the channel has a
 * backend. An optional catch-all keeps that to one file instead of a
 * placeholder page per row (settings, dm-agents, posts, comments,
 * intents), so adding a panel row costs nothing until the real pages
 * exist to replace it.
 */
export default async function InstagramChannelPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  return (
    <ChannelConnectScreen
      channel="instagram"
      section={panelSectionLabel('instagram', section?.[0])}
    />
  );
}
