import { ChannelConnectScreen } from '@/components/channels/channel-connect-screen';
import { panelSectionLabel } from '@/lib/nav/channels';

/**
 * Web Chat — same shape as the Instagram placeholder: one optional
 * catch-all answering every panel row until the widget backend exists.
 */
export default async function WebChannelPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  return (
    <ChannelConnectScreen
      channel="web"
      section={panelSectionLabel('web', section?.[0])}
    />
  );
}
