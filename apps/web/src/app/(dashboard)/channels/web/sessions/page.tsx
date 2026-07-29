import { WebSessions } from '@/components/channels/web/web-sessions';

/**
 * Web channel → Sessions.
 *
 * The only place the `web_sessions` table surfaces. It answers the one
 * question `messages` cannot: which page or campaign produced a conversation.
 */
export default function WebSessionsPage() {
  return <WebSessions />;
}
