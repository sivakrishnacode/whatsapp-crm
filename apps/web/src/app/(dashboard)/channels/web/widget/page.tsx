import { WebWidgetAppearance } from '@/components/channels/web/web-widget-appearance';

/**
 * Web Widget — appearance, copy, behaviour, and a live preview.
 *
 * Split from Channel Settings on purpose: that page is setup (domains,
 * snippet, keys) and is visited once, this one is design and gets revisited.
 * Putting both on one page buried the colour picker under key rotation.
 */
export default function WebWidgetPage() {
  return <WebWidgetAppearance />;
}
