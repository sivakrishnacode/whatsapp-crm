import { WebBehaviour } from '@/components/channels/web/web-behaviour';

/**
 * Web channel → Behaviour: pre-chat form, business hours, offline form.
 *
 * Split from both Channel Settings (setup: domains, snippet, keys) and Web
 * Widget (design: colours, copy) because it is neither — it is what the widget
 * *does*, and the three get changed at different times by different people.
 */
export default function WebBehaviourPage() {
  return <WebBehaviour />;
}
