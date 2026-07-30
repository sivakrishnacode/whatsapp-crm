/**
 * Pre-built starter templates for the "Use a template" gallery.
 *
 * Every entry is a complete, Meta-valid template: contiguous {{n}}
 * placeholders, a sample value for each, footers under 60 chars with no
 * variables, quick-reply buttons grouped ahead of CTAs, and real HTTPS
 * URLs on link buttons. That is not a claim — `template-library.test.ts`
 * runs each entry through the same `validateTemplatePayload` the submit
 * route uses, so an entry that would be rejected fails the build instead
 * of reaching a user.
 *
 * The one thing an entry cannot supply is media. An IMAGE/VIDEO/FILE or
 * CAROUSEL starter arrives with its media slot empty because there is no
 * asset to ship — `needsMedia` flags those so the gallery can say so up
 * front, and validation still blocks submit until the user adds their
 * own.
 *
 * Category matters for approval, not just filing: Meta reads UTILITY as
 * "about a transaction the customer has already entered into", so the
 * utility copy here stays tied to a specific order, appointment, invoice
 * or ticket, and anything promotional lives under MARKETING.
 */

import {
  emptyTemplateForm,
  type TemplateFormData,
  type TemplateTypeOption,
} from './template-form';

export interface LibraryTemplate {
  id: string;
  title: string;
  description: string;
  category: 'Marketing' | 'Utility';
  type: TemplateTypeOption;
  /** True when the user must attach their own media before submitting. */
  needsMedia: boolean;
  form: TemplateFormData;
}

/**
 * Build a full form from a partial, so entries stay readable.
 *
 * `template_type` and `category` are derived from the entry's metadata
 * rather than repeated in the form — declaring them twice is how the
 * first draft of this file shipped every starter as a plain-text
 * template regardless of the header it described.
 */
function entry(
  meta: Omit<LibraryTemplate, 'form' | 'needsMedia'>,
  form: Partial<TemplateFormData>,
): LibraryTemplate {
  const merged: TemplateFormData = {
    ...emptyTemplateForm,
    ...form,
    template_type: meta.type,
    category: meta.category,
  };
  const needsMedia =
    (['IMAGE', 'VIDEO', 'FILE'] as TemplateTypeOption[]).includes(meta.type) ||
    (meta.type === 'CAROUSEL' &&
      merged.cards.some((c) => !c.header_media_url && !c.header_media_file));
  return { ...meta, needsMedia, form: merged };
}

export const TEMPLATE_LIBRARY: LibraryTemplate[] = [
  // ---------------------------------------------------------------
  // Marketing
  // ---------------------------------------------------------------
  entry(
    {
      id: 'special_discount_offer',
      title: 'Special discount offer',
      description: 'Percentage-off promo with a code and an expiry date.',
      category: 'Marketing',
      type: 'NONE',
    },
    {
      name: 'special_discount_offer',
      category: 'Marketing',
      body_text:
        "Hi {{1}}! Here's {{2}}% off your next order. Use code {{3}} at checkout before {{4}} to claim it.",
      body_samples: ['Asha', '20', 'SAVE20', '31 August'],
      footer_text: 'Reply STOP to opt out of offers',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
        { type: 'URL', text: 'Shop now', url: 'https://example.com/shop' },
      ],
    },
  ),

  entry(
    {
      id: 'new_arrivals_notification',
      title: 'New arrivals announcement',
      description: 'Text header naming the collection, with a shop link.',
      category: 'Marketing',
      type: 'TEXT',
    },
    {
      name: 'new_arrivals_notification',
      category: 'Marketing',
      header_content: 'New arrivals: {{1}}',
      header_sample: 'Summer collection',
      body_text:
        "Hey {{1}}, our new {{2}} collection just landed. Have a look before the popular sizes go.",
      body_samples: ['Asha', 'summer'],
      footer_text: 'Reply STOP to opt out of offers',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
        {
          type: 'URL',
          text: 'View collection',
          url: 'https://example.com/new-in',
        },
      ],
    },
  ),

  entry(
    {
      id: 'abandoned_cart_recovery',
      title: 'Abandoned cart reminder',
      description: 'Recovers a left-behind cart with a discount code.',
      category: 'Marketing',
      type: 'NONE',
    },
    {
      name: 'abandoned_cart_recovery',
      category: 'Marketing',
      body_text:
        "Hi {{1}}, you left {{2}} in your cart. Use code {{3}} to save {{4}} — we'll hold it for the next 24 hours.",
      body_samples: ['Asha', '2 items', 'CART10', '10%'],
      footer_text: 'Reply STOP to opt out of offers',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
        {
          type: 'URL',
          text: 'Back to cart',
          url: 'https://example.com/cart/{{1}}',
          example: 'a1b2c3',
        },
      ],
    },
  ),

  entry(
    {
      id: 'free_gift_promotion',
      title: 'Free gift with purchase',
      description: 'Spend-threshold promo with a gift incentive.',
      category: 'Marketing',
      type: 'NONE',
    },
    {
      name: 'free_gift_promotion',
      category: 'Marketing',
      body_text:
        "It's your lucky day, {{1}}! Spend over {{2}} today and we'll add a free {{3}} to your order.",
      body_samples: ['Asha', '₹1,500', 'travel pouch'],
      footer_text: 'Reply STOP to opt out of offers',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
        { type: 'URL', text: 'Claim gift', url: 'https://example.com/gift' },
      ],
    },
  ),

  entry(
    {
      id: 'final_sale_reminder',
      title: 'Last-chance sale reminder',
      description: 'Urgency reminder for a sale that ends soon.',
      category: 'Marketing',
      type: 'NONE',
    },
    {
      name: 'final_sale_reminder',
      category: 'Marketing',
      body_text:
        'Final call, {{1}} — our {{2}} ends in {{3}}. Everything still in stock is discounted.',
      body_samples: ['Asha', 'monsoon sale', '24 hours'],
      footer_text: 'Reply STOP to opt out of offers',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
        { type: 'URL', text: 'Shop the sale', url: 'https://example.com/sale' },
      ],
    },
  ),

  entry(
    {
      id: 'back_in_stock_alert',
      title: 'Back in stock alert',
      description: 'Tells a waitlisted customer their item returned.',
      category: 'Marketing',
      type: 'NONE',
    },
    {
      name: 'back_in_stock_alert',
      category: 'Marketing',
      body_text:
        'Good news {{1}}, the {{2}} you asked about is back in stock and ready to order.',
      body_samples: ['Asha', 'the linen shirt in medium'],
      footer_text: 'Reply STOP to opt out of alerts',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop alerts' },
        { type: 'URL', text: 'Buy now', url: 'https://example.com/product' },
      ],
    },
  ),

  entry(
    {
      id: 'product_launch_image',
      title: 'Product launch (image)',
      description: 'Image header for a launch announcement. Add your own image.',
      category: 'Marketing',
      type: 'IMAGE',
    },
    {
      name: 'product_launch_image',
      category: 'Marketing',
      body_text:
        "Hi {{1}}, meet {{2}}. It's live today, and the launch price of {{3}} holds until {{4}} — take a look.",
      body_samples: ['Asha', 'the Aurora backpack', '₹2,499', 'Sunday'],
      footer_text: 'Reply STOP to opt out of offers',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
        { type: 'URL', text: 'See it', url: 'https://example.com/launch' },
      ],
    },
  ),

  entry(
    {
      id: 'flash_sale_video',
      title: 'Flash sale (video)',
      description: 'Short video header for a timed sale. Add your own video.',
      category: 'Marketing',
      type: 'VIDEO',
    },
    {
      name: 'flash_sale_video',
      category: 'Marketing',
      body_text:
        'Hi {{1}}, our {{2}} flash sale is live for the next {{3}}. Watch the clip for the highlights.',
      body_samples: ['Asha', '48-hour', '48 hours'],
      footer_text: 'Reply STOP to opt out of offers',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
        { type: 'URL', text: 'Shop the sale', url: 'https://example.com/flash' },
      ],
    },
  ),

  entry(
    {
      id: 'seasonal_lookbook_pdf',
      title: 'Lookbook / catalogue (file)',
      description: 'PDF header for a seasonal catalogue. Attach your own PDF.',
      category: 'Marketing',
      type: 'FILE',
    },
    {
      name: 'seasonal_lookbook_pdf',
      category: 'Marketing',
      body_text:
        "Hi {{1}}, our {{2}} lookbook is attached. {{3}} new pieces, and every one is in stock today.",
      body_samples: ['Asha', 'festive', '32'],
      footer_text: 'Reply STOP to opt out of offers',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
        { type: 'URL', text: 'Browse online', url: 'https://example.com/lookbook' },
      ],
    },
  ),

  entry(
    {
      id: 'bestsellers_carousel',
      title: 'Bestsellers carousel',
      description:
        'Three swipeable product cards. Add an image to each card before submitting.',
      category: 'Marketing',
      type: 'CAROUSEL',
    },
    {
      name: 'bestsellers_carousel',
      category: 'Marketing',
      body_text:
        'Hi {{1}}, these are our three bestsellers this month — all in stock and ready to ship.',
      body_samples: ['Asha'],
      cards: [
        {
          header_format: 'image',
          header_media_url: '',
          header_media_file: null,
          body_text: 'Now {{1}} at {{2}} while stock lasts.',
          body_samples: ['Aurora backpack', '₹2,499'],
          buttons: [
            {
              type: 'URL',
              text: 'View',
              url: 'https://example.com/p/1',
            },
          ],
        },
        {
          header_format: 'image',
          header_media_url: '',
          header_media_file: null,
          body_text: 'Now {{1}} at {{2}} while stock lasts.',
          body_samples: ['Trail runner', '₹3,199'],
          buttons: [
            {
              type: 'URL',
              text: 'View',
              url: 'https://example.com/p/2',
            },
          ],
        },
        {
          header_format: 'image',
          header_media_url: '',
          header_media_file: null,
          body_text: 'Now {{1}} at {{2}} while stock lasts.',
          body_samples: ['Everyday tote', '₹1,899'],
          buttons: [
            {
              type: 'URL',
              text: 'View',
              url: 'https://example.com/p/3',
            },
          ],
        },
      ],
    },
  ),

  // ---------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------
  entry(
    {
      id: 'order_confirmation',
      title: 'Order confirmation',
      description: 'Confirms a placed order with its number and total.',
      category: 'Utility',
      type: 'NONE',
    },
    {
      name: 'order_confirmation',
      category: 'Utility',
      body_text:
        "Thanks for your order, {{1}}! Order {{2}} is confirmed and totals {{3}}. We'll message you the moment it ships.",
      body_samples: ['Asha', '#A-10428', '₹2,499'],
      footer_text: 'Questions? Just reply to this message',
      buttons: [
        {
          type: 'URL',
          text: 'View order',
          url: 'https://example.com/orders/{{1}}',
          example: 'A-10428',
        },
      ],
    },
  ),

  entry(
    {
      id: 'order_shipped',
      title: 'Order shipped',
      description: 'Dispatch notice with carrier and tracking number.',
      category: 'Utility',
      type: 'NONE',
    },
    {
      name: 'order_shipped',
      category: 'Utility',
      body_text:
        'Hi {{1}}, order {{2}} is on its way via {{3}}. The tracking number is {{4}} and it should arrive by {{5}}, we will keep you posted.',
      body_samples: ['Asha', '#A-10428', 'BlueDart', 'BD5512789', 'Thursday'],
      footer_text: 'Questions? Just reply to this message',
      buttons: [
        {
          type: 'URL',
          text: 'Track parcel',
          url: 'https://example.com/track/{{1}}',
          example: 'BD5512789',
        },
      ],
    },
  ),

  entry(
    {
      id: 'out_for_delivery_location',
      title: 'Out for delivery (map pin)',
      description:
        'Location header — the delivery address is set per message at send time.',
      category: 'Utility',
      type: 'LOCATION',
    },
    {
      name: 'out_for_delivery_location',
      category: 'Utility',
      body_text:
        'Good news {{1}}! Order {{2}} is out for delivery to the address above and should arrive by {{3}} today.',
      body_samples: ['Asha', '#A-10428', '6 PM'],
      buttons: [{ type: 'QUICK_REPLY', text: 'Stop updates' }],
    },
  ),

  entry(
    {
      id: 'appointment_reminder',
      title: 'Appointment reminder',
      description: 'Text header plus confirm / reschedule quick replies.',
      category: 'Utility',
      type: 'TEXT',
    },
    {
      name: 'appointment_reminder',
      category: 'Utility',
      header_content: 'Reminder: {{1}}',
      header_sample: 'Tomorrow at 4 PM',
      body_text:
        'Hi {{1}}, your {{2}} appointment is on {{3}} at {{4}}. Reply below if anything has changed.',
      body_samples: ['Asha', 'dental check-up', 'Tuesday 12 Aug', '4:00 PM'],
      footer_text: 'Reply to this message to reach us',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Confirm' },
        { type: 'QUICK_REPLY', text: 'Reschedule' },
      ],
    },
  ),

  entry(
    {
      id: 'invoice_due_reminder',
      title: 'Invoice due reminder',
      description: 'Text header plus a pay-now link.',
      category: 'Utility',
      type: 'TEXT',
    },
    {
      name: 'invoice_due_reminder',
      category: 'Utility',
      header_content: 'Invoice {{1}} is due',
      header_sample: 'INV-2041',
      body_text:
        'Hi {{1}}, invoice {{2}} for {{3}} is due on {{4}}. You can settle it from the link below.',
      body_samples: ['Asha', 'INV-2041', '₹8,400', '15 August'],
      footer_text: 'Already paid? Ignore this message',
      buttons: [
        {
          type: 'URL',
          text: 'Pay invoice',
          url: 'https://example.com/pay/{{1}}',
          example: 'INV-2041',
        },
      ],
    },
  ),

  entry(
    {
      id: 'payment_receipt_pdf',
      title: 'Payment receipt (file)',
      description: 'PDF header for a receipt. Attach the receipt PDF.',
      category: 'Utility',
      type: 'FILE',
    },
    {
      name: 'payment_receipt_pdf',
      category: 'Utility',
      body_text:
        'Hi {{1}}, your receipt for {{2}} is attached. We received {{3}} on {{4}}, thanks for your payment.',
      body_samples: ['Asha', 'order #A-10428', '₹2,499', '30 July'],
      footer_text: 'Keep this for your records',
    },
  ),

  entry(
    {
      id: 'support_ticket_update',
      title: 'Support ticket update',
      description: 'Status change on an open support ticket.',
      category: 'Utility',
      type: 'NONE',
    },
    {
      name: 'support_ticket_update',
      category: 'Utility',
      body_text:
        'Hi {{1}}, ticket {{2}} is now {{3}} and {{4}} from our team will follow up here shortly.',
      body_samples: ['Asha', '#T-3391', 'in progress', 'Ravi'],
      footer_text: 'Reply here to add to this ticket',
      buttons: [
        {
          type: 'URL',
          text: 'View ticket',
          url: 'https://example.com/tickets/{{1}}',
          example: 'T-3391',
        },
      ],
    },
  ),

  entry(
    {
      id: 'feedback_request',
      title: 'Feedback request',
      description: 'Post-purchase rating prompt with quick replies.',
      category: 'Utility',
      type: 'NONE',
    },
    {
      name: 'feedback_request',
      category: 'Utility',
      body_text:
        'Hi {{1}}, how did we do with {{2}}? A one-tap answer below is plenty — it helps us fix what needs fixing.',
      body_samples: ['Asha', 'order #A-10428'],
      footer_text: 'Thanks for helping us improve',
      buttons: [
        { type: 'QUICK_REPLY', text: 'All good' },
        { type: 'QUICK_REPLY', text: 'Had a problem' },
      ],
    },
  ),
];

/** Filter values for the gallery's left rail. */
export const LIBRARY_TYPE_FILTERS: {
  value: 'ALL' | TemplateTypeOption;
  label: string;
}[] = [
  { value: 'ALL', label: 'All' },
  { value: 'NONE', label: 'Text only' },
  { value: 'TEXT', label: 'Text header' },
  { value: 'IMAGE', label: 'Image' },
  { value: 'FILE', label: 'File' },
  { value: 'VIDEO', label: 'Video' },
  { value: 'LOCATION', label: 'Location' },
  { value: 'CAROUSEL', label: 'Carousel' },
];

export function filterLibrary(
  category: LibraryTemplate['category'],
  type: 'ALL' | TemplateTypeOption,
): LibraryTemplate[] {
  return TEMPLATE_LIBRARY.filter(
    (t) => t.category === category && (type === 'ALL' || t.type === type),
  );
}
