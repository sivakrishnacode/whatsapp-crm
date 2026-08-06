import { clickToWhatsAppBuilder } from './click-to-whatsapp.builder';
import { leadFormBuilder } from './lead-form.builder';
import { websiteBuilder } from './website.builder';
import { websiteToWhatsAppBuilder } from './website-to-whatsapp.builder';
import { whatsappStatusBuilder } from './whatsapp-status.builder';
import { AD_TYPE_IDS, type AdTypeBuilder, type AdTypeId } from './types';

/**
 * The ad-type registry.
 *
 * Adding a sixth ad type is: one builder file, one import, one entry
 * here. `AdPublishService` needs no change — it is entirely
 * type-agnostic, which is the whole point of the contract in `types.ts`.
 *
 * Order matters: it is the order the wizard renders the cards in, and
 * Click-to-WhatsApp is first because it is the one that feeds this
 * product's own inbox.
 */
export const AD_TYPES: Record<AdTypeId, AdTypeBuilder> = {
  click_to_whatsapp: clickToWhatsAppBuilder,
  whatsapp_status: whatsappStatusBuilder,
  website_to_whatsapp: websiteToWhatsAppBuilder,
  website: websiteBuilder,
  lead_form: leadFormBuilder,
};

/** Card order in the wizard's first step. */
export const AD_TYPE_ORDER: AdTypeId[] = [
  'click_to_whatsapp',
  'whatsapp_status',
  'website_to_whatsapp',
  'website',
  'lead_form',
];

export function isAdTypeId(value: unknown): value is AdTypeId {
  return (
    typeof value === 'string' &&
    (AD_TYPE_IDS as readonly string[]).includes(value)
  );
}

/**
 * Fail loudly at boot if the registry and the ids drift apart.
 *
 * A missing entry would otherwise surface as `AD_TYPES[id]` being
 * undefined at publish time — after the user has filled in the whole
 * wizard. This turns that into a startup error.
 */
for (const id of AD_TYPE_IDS) {
  if (!AD_TYPES[id]) {
    throw new Error(`Ad type "${id}" has no builder registered.`);
  }
  if (AD_TYPES[id].id !== id) {
    throw new Error(
      `Ad type builder registered under "${id}" reports its id as "${AD_TYPES[id].id}".`,
    );
  }
}

export { AD_TYPE_IDS };
export type { AdTypeBuilder, AdTypeId };
export * from './types';
