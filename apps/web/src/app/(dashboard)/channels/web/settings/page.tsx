import { WebConfig } from '@/components/channels/web/web-config';

/**
 * Web channel settings — domain allowlist, install snippet, key rotation.
 *
 * Takes precedence over the sibling `[[...section]]` catch-all: a
 * concrete segment always beats an optional catch-all in Next's route
 * matching, so the remaining panel rows (widget, knowledge, sessions)
 * keep falling through to the connect screen until they get real pages.
 */
export default function WebChannelSettingsPage() {
  return <WebConfig />;
}
