import { AdsLeadForms } from '@/components/ads/ads-lead-forms';

/**
 * Ads Manager → Lead Forms. Meta *instant* forms, rendered by Facebook
 * inside an ad.
 *
 * Unrelated to `/forms`, which is this product's own hosted web-form
 * builder — hence the separate route and the separate label. Submissions
 * arrive on the existing /webhooks/facebook-leads endpoint.
 */
export default function AdsLeadFormsPage() {
  return <AdsLeadForms />;
}
