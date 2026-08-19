/**
 * Instagram webhook payload shapes.
 *
 * Transcribed from the "Webhook payload reference" folder of
 * notes/Instagram API.postman_collection.json.
 *
 * THE ENVELOPE IS MESSENGER-SHAPED, NOT WHATSAPP-SHAPED
 *   WhatsApp:  entry[].changes[].value.messages[]
 *   Instagram: entry[].messaging[]
 *   ...and comments arrive as entry[].field + entry[].value, or
 *   sometimes wrapped in entry[].changes[] depending on the Graph
 *   version. Both are handled — see InstagramWebhookService.
 *
 * WHO IS WHO
 *   Meta's own docs call this out as the confusing part. The direction
 *   of a `messaging` event is not in a field; you infer it:
 *
 *     inbound  — sender.id = the customer's IGSID
 *                recipient.id = the business's IG user id (= entry.id)
 *     outbound — sender.id = the business's IG user id
 *                recipient.id = the customer's IGSID
 *                message.is_echo = true
 *
 *   So `entry.id` is the anchor: whichever side equals it is the
 *   business. Everything downstream depends on getting this right.
 */

export interface IgWebhookBody {
  object?: string;
  entry?: IgWebhookEntry[];
}

export interface IgWebhookEntry {
  /** The business's Instagram professional account id. Routes to a config row. */
  id: string;
  time?: number | string;
  messaging?: IgMessagingEvent[];
  /** Comment/mention events, flat form. */
  field?: string;
  value?: IgCommentValue;
  /** Comment/mention events, wrapped form (varies by Graph version). */
  changes?: Array<{ field: string; value: IgCommentValue }>;
}

export interface IgMessagingEvent {
  /**
   * ⚠ OPTIONAL DESPITE THE DOCS. Every messaging payload in Meta's own
   * reference carries both sides, and Instagram has been observed
   * sending events with neither — so this is `?` to force the guard at
   * every read. See `resolveCustomerIgsid`.
   */
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number | string;
  message?: IgInboundMessage;
  message_edit?: IgMessageEdit;
  reaction?: IgReactionEvent;
  read?: { mid: string };
  postback?: IgPostback;
  referral?: IgReferral;
}

export interface IgInboundMessage {
  mid: string;
  text?: string;
  attachments?: IgAttachment[];
  quick_reply?: { payload: string };
  /**
   * True when the business sent the message — from the Instagram app
   * itself, another tool, or our own API call coming back to us. These
   * MUST be ingested (otherwise agent replies sent from a phone are
   * invisible in the CRM) and MUST be deduped against sends we made
   * ourselves.
   */
  is_echo?: boolean;
  /** Business messaging its own account. Ignorable. */
  is_self?: boolean;
  is_deleted?: boolean;
  /** Message type the API cannot represent (e.g. a poll). Text is absent. */
  is_unsupported?: boolean;
  reply_to?: {
    mid?: string;
    story?: { id?: string; url?: string };
  };
  referral?: IgReferral;
}

export interface IgMessageEdit {
  mid: string;
  text?: string;
  num_edit?: number | string;
}

export interface IgAttachment {
  /**
   * `share` is a shared post/link, `story_mention` is the business
   * being @-mentioned in someone's story, `ig_reel` a shared reel.
   */
  type:
    | 'image'
    | 'video'
    | 'audio'
    | 'file'
    | 'share'
    | 'story_mention'
    | 'ig_reel'
    // `string & {}` rather than a bare `string`: a plain union with
    // `string` collapses to `string` and throws away both the
    // autocomplete and the documentation value of the literals above.
    // Meta can add attachment types without warning, so the escape
    // hatch has to stay — this keeps it without erasing the known set.
    | (string & {});
  payload?: {
    url?: string;
    title?: string;
    /** Present on reel shares. */
    reel_video_id?: string;
    sticker_id?: number | string;
  };
}

export interface IgReactionEvent {
  mid: string;
  action: 'react' | 'unreact' | (string & {});
  /** Named reaction ('love', 'wow', …). Absent on unreact. */
  reaction?: string;
  /** The rendered emoji. Absent on unreact. */
  emoji?: string;
}

export interface IgPostback {
  mid?: string;
  /** The ice-breaker question or button label the user tapped. */
  title?: string;
  /** The developer-defined payload behind it. */
  payload?: string;
  referral?: IgReferral;
}

/** ig.me deep-link attribution. */
export interface IgReferral {
  ref?: string;
  source?: string;
  type?: string;
  ads_context_data?: Record<string, unknown>;
}

export interface IgCommentValue {
  id: string;
  from?: { id?: string; username?: string };
  text?: string;
  parent_id?: string;
  media?: {
    id?: string;
    media_product_type?: string;
    ad_id?: string;
  };
  timestamp?: number | string;
}
