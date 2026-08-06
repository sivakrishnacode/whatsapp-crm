import { AdsLeads } from '@/components/ads/ads-leads';

/**
 * Ads Manager → Leads. Ad spend attributed to the contacts and deals it
 * produced — the join Meta's own Ads Manager cannot do, because it has
 * never seen this CRM's pipeline.
 */
export default function AdsLeadsPage() {
  return <AdsLeads />;
}
