import { AdsOverview } from '@/components/ads/ads-overview';

/**
 * Ads Manager → Overview. Spend, results and per-campaign performance.
 *
 * Also the rail row's target, so it must exist rather than being a
 * placeholder — a rail row pointing at a route with no page 404s, which
 * is the trap `channelLandingHref` documents in lib/nav/channels.ts.
 */
export default function AdsOverviewPage() {
  return <AdsOverview />;
}
