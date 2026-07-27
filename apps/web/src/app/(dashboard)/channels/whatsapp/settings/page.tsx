import { WhatsAppConfig } from '@/components/settings/whatsapp-config';

/**
 * WhatsApp channel settings — the connection form's new home.
 *
 * The same `<WhatsAppConfig />` component previously rendered only inside
 * `/settings?tab=whatsapp`. It now lives here (self-contained channel
 * context), and the Settings panel's WhatsApp row deep-links to this
 * route rather than duplicating the form. One source of truth, reachable
 * from both places.
 */
export default function WhatsAppChannelSettingsPage() {
  return <WhatsAppConfig />;
}
