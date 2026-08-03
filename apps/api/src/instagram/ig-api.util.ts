/**
 * Instagram API helpers — the "Instagram Login" surface.
 *
 * Reference: notes/Instagram API.postman_collection.json →
 * "Instagram API with Instagram Login". The collection's other half
 * ("Instagram API with Facebook Login") is a different token model and
 * is NOT what this file speaks.
 *
 * THREE HOSTS, DO NOT MIX THEM
 *   www.instagram.com/oauth/authorize   — the consent dialog (browser)
 *   api.instagram.com/oauth/access_token — code → short-lived token
 *   graph.instagram.com/<version>/...    — everything else
 *
 * HOW THIS DIFFERS FROM whatsapp/meta-api.util.ts
 *   Same house style — every function takes one named-options object,
 *   never positional args — but a different host, a different app
 *   (INSTAGRAM_APP_ID/SECRET, not META_APP_ID/SECRET) and a
 *   Messenger-shaped message envelope: `{recipient:{id}, message:{...}}`
 *   rather than WhatsApp's `{messaging_product, to, type, ...}`.
 *
 * TOKEN LIFECYCLE
 *   Instagram long-lived tokens expire after 60 days and there is no
 *   silent renewal — `refreshLongLivedToken` must run before then or
 *   the connection simply dies. See InstagramTokenRefreshService.
 */

import { throwClassifiedMetaError } from '../common/messaging/meta-errors';

/**
 * Pinned, overridable per environment. The Postman collection targets
 * v23.0; bumping is a config change, not a code change, so a Graph
 * version deprecation doesn't require a deploy.
 */
export const IG_API_VERSION = process.env.INSTAGRAM_API_VERSION || 'v23.0';

export const IG_GRAPH_BASE = `https://graph.instagram.com/${IG_API_VERSION}`;
const IG_OAUTH_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const IG_OAUTH_TOKEN = 'https://api.instagram.com/oauth/access_token';

/**
 * Scopes for DMs + comment moderation.
 *
 * `instagram_business_manage_messages` and
 * `instagram_business_manage_comments` are Advanced Access permissions:
 * until Meta approves them the app can only exchange messages with
 * accounts that hold a role on it. See
 * notes/instagram-meta-setup-checklist.md §5.
 */
export const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
] as const;

/**
 * Webhook fields subscribed at connect time.
 *
 * Deliberately excludes `standby` and `messaging_handover` (the handover
 * protocol, for apps that pass threads between each other — out of
 * scope) and `story_insights` (analytics, out of scope). Subscribing to
 * fields we don't handle just burns webhook volume.
 */
export const IG_WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'messaging_seen',
  'messaging_referral',
  'message_reactions',
  'comments',
  'live_comments',
  'mentions',
] as const;

// ============================================================
// Shared request plumbing
// ============================================================

interface IgSendResponse {
  recipient_id?: string;
  message_id?: string;
}

async function igFetch<T>(
  url: string,
  init: RequestInit,
  fallbackMessage: string,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    await throwClassifiedMetaError(response, fallbackMessage);
  }
  return (await response.json()) as T;
}

function igPost<T>(
  url: string,
  accessToken: string,
  body: unknown,
): Promise<T> {
  return igFetch<T>(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    },
    'Instagram API request failed',
  );
}

function igGet<T>(url: string, accessToken: string): Promise<T> {
  return igFetch<T>(
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    'Instagram API request failed',
  );
}

/**
 * Every outbound message is a POST to the same endpoint with a
 * different `message` payload — this is the one place that knows that.
 */
async function sendMessagePayload(args: {
  igUserId: string;
  accessToken: string;
  body: Record<string, unknown>;
}): Promise<IgSendResult> {
  const data = await igPost<IgSendResponse>(
    `${IG_GRAPH_BASE}/${args.igUserId}/messages`,
    args.accessToken,
    args.body,
  );
  return {
    messageId: data.message_id ?? '',
    recipientId: data.recipient_id,
  };
}

export interface IgSendResult {
  /** Instagram's `mid`. Stored on messages.message_id for echo dedupe. */
  messageId: string;
  recipientId?: string;
}

/**
 * Common shape of an outbound send. `tag` is only ever 'HUMAN_AGENT' —
 * the sole way to message a user more than 24h after their last
 * message, and only with Meta's Human Agent approval.
 */
interface BaseSendArgs {
  igUserId: string;
  accessToken: string;
  /** The recipient's Instagram-scoped ID (IGSID). */
  recipientId: string;
  tag?: 'HUMAN_AGENT';
}

function withTag(
  body: Record<string, unknown>,
  tag?: 'HUMAN_AGENT',
): Record<string, unknown> {
  return tag ? { ...body, tag } : body;
}

// ============================================================
// OAuth — Instagram Login
// ============================================================

export interface BuildAuthorizeUrlArgs {
  appId: string;
  redirectUri: string;
  /** Signed, account-bound CSRF token. Echoed back on the callback. */
  state: string;
  scopes?: readonly string[];
}

export function buildAuthorizeUrl(args: BuildAuthorizeUrlArgs): string {
  const params = new URLSearchParams({
    client_id: args.appId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: (args.scopes ?? IG_SCOPES).join(','),
    state: args.state,
  });
  return `${IG_OAUTH_AUTHORIZE}?${params.toString()}`;
}

export interface ShortLivedToken {
  accessToken: string;
  /**
   * The **app-scoped** id of the connecting account — NOT the
   * professional account id that `/subscribed_apps`, `/messages` and
   * the rest of the Graph surface expect.
   *
   * Do not use this to address the API. Call `getSelfProfile('me')`
   * with the token and use the `igUserId` it returns. This value is
   * kept only so it can be stored for webhook routing, since
   * `entry[].id` sometimes carries this form.
   */
  appScopedUserId: string;
  permissions?: string[];
}

/**
 * Pull a numeric field out of raw JSON text as a string.
 *
 * WHY NOT JSON.parse
 *   Instagram account ids exceed 2^53 (`28011694518467843` ≈ 2.8e16
 *   against a 9.0e15 ceiling), so `JSON.parse` silently rounds them to
 *   the nearest representable double — `…843` becomes `…844`. Every
 *   subsequent call then addresses an object that does not exist, and
 *   Meta answers with a generic "Object with ID … does not exist,
 *   cannot be loaded due to missing permissions, or does not support
 *   this operation" that says nothing about the real cause.
 *
 *   `String(parsed.user_id)` does not help: the precision is already
 *   gone by the time the value is a JS number. The digits have to be
 *   read out of the text before it is parsed.
 */
function extractRawNumericField(json: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"?(\\d+)"?`).exec(json);
  return match?.[1] ?? null;
}

/**
 * Exchange the OAuth `code` for a short-lived (1 hour) token.
 *
 * Note the content type: this endpoint takes form-encoded data, not
 * JSON, and lives on api.instagram.com rather than graph.instagram.com.
 * Both are easy to get wrong and both fail with unhelpful errors.
 */
export async function exchangeCodeForToken(args: {
  code: string;
  appId: string;
  appSecret: string;
  redirectUri: string;
}): Promise<ShortLivedToken> {
  const form = new URLSearchParams({
    client_id: args.appId,
    client_secret: args.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: args.redirectUri,
    code: args.code,
  });

  const response = await fetch(IG_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  if (!response.ok) {
    await throwClassifiedMetaError(
      response,
      'Failed to exchange Instagram authorization code',
    );
  }

  // Read the body as TEXT first. `user_id` is a JSON number wider than
  // 2^53, so parsing before extracting it corrupts the id — see
  // extractRawNumericField.
  const raw = await response.text();
  const data = JSON.parse(raw) as {
    access_token: string;
    permissions?: string[] | string;
  };

  const appScopedUserId = extractRawNumericField(raw, 'user_id');
  if (!appScopedUserId) {
    throw new Error(
      'Instagram did not return a user_id with the access token.',
    );
  }

  return {
    accessToken: data.access_token,
    appScopedUserId,
    permissions: Array.isArray(data.permissions)
      ? data.permissions
      : typeof data.permissions === 'string'
        ? data.permissions.split(',').filter(Boolean)
        : undefined,
  };
}

export interface LongLivedToken {
  accessToken: string;
  /** Seconds until expiry — roughly 60 days. */
  expiresIn: number;
}

/** Trade a short-lived token for a 60-day one. */
export async function exchangeForLongLivedToken(args: {
  shortLivedToken: string;
  appSecret: string;
}): Promise<LongLivedToken> {
  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: args.appSecret,
    access_token: args.shortLivedToken,
  });

  const data = await igFetch<{ access_token: string; expires_in: number }>(
    `https://graph.instagram.com/access_token?${params.toString()}`,
    { method: 'GET' },
    'Failed to exchange for a long-lived Instagram token',
  );

  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/**
 * Extend a long-lived token by another 60 days.
 *
 * Meta's two constraints, both of which fail confusingly:
 *   - the token must be at least 24 HOURS old, and
 *   - it must not have expired yet (there is no grace period).
 * Once expired the only remedy is a full re-authorisation by the user.
 */
export async function refreshLongLivedToken(args: {
  longLivedToken: string;
}): Promise<LongLivedToken> {
  const params = new URLSearchParams({
    grant_type: 'ig_refresh_token',
    access_token: args.longLivedToken,
  });

  const data = await igFetch<{ access_token: string; expires_in: number }>(
    `https://graph.instagram.com/refresh_access_token?${params.toString()}`,
    { method: 'GET' },
    'Failed to refresh the Instagram access token',
  );

  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

// ============================================================
// Account + profile
// ============================================================

export interface IgAccountProfile {
  /** The Instagram professional account id (`user_id`). */
  igUserId: string;
  /**
   * The app-scoped id the same account reports as `id`. Distinct from
   * `igUserId`, and either can appear as a webhook's `entry[].id` — both
   * are stored so routing can match on either.
   */
  igAppScopedId?: string;
  username?: string;
  name?: string;
  profilePictureUrl?: string;
  followersCount?: number;
}

/**
 * The connected business's own profile — and the authoritative source
 * for both of its ids.
 *
 * Pass `'me'` when the account id is not yet known. Right after a token
 * exchange this is the ONLY correct way to learn the professional
 * account id: the OAuth response's `user_id` is the app-scoped id, and
 * addressing the Graph API with that one fails with a misleading
 * "Object with ID … does not exist" error.
 */
export async function getSelfProfile(args: {
  igUserId: string;
  accessToken: string;
}): Promise<IgAccountProfile> {
  const fields = 'user_id,username,name,profile_picture_url,followers_count';

  // Text-first for the same reason as the token exchange: both ids are
  // wider than 2^53 and JSON.parse would round them off by one.
  const response = await fetch(
    `${IG_GRAPH_BASE}/${args.igUserId}?fields=${fields}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  );
  if (!response.ok) {
    await throwClassifiedMetaError(response, 'Instagram API request failed');
  }
  const rawBody = await response.text();
  const data = JSON.parse(rawBody) as {
    username?: string;
    name?: string;
    profile_picture_url?: string;
    followers_count?: number;
  };

  const professionalId =
    extractRawNumericField(rawBody, 'user_id') ??
    extractRawNumericField(rawBody, 'id') ??
    args.igUserId;
  const appScopedId = extractRawNumericField(rawBody, 'id') ?? undefined;

  return {
    igUserId: professionalId,
    // Only record it when it genuinely differs — storing the same value
    // twice would make the partial unique index reject a second account
    // for no reason.
    igAppScopedId:
      appScopedId && appScopedId !== professionalId ? appScopedId : undefined,
    username: data.username,
    name: data.name,
    profilePictureUrl: data.profile_picture_url,
    followersCount: data.followers_count,
  };
}

export interface IgUserProfile {
  igsid: string;
  name?: string;
  username?: string;
  profilePictureUrl?: string;
  isVerifiedUser?: boolean;
  followerCount?: number;
  isUserFollowBusiness?: boolean;
  isBusinessFollowUser?: boolean;
}

/**
 * Look up a customer by their Instagram-scoped ID.
 *
 * Only works for users who have messaged the business — there is no
 * general user lookup, by design. Callers must treat failure as
 * non-fatal: an unresolvable profile means we display the IGSID, not
 * that the message should be dropped.
 */
export async function getUserProfile(args: {
  igsid: string;
  accessToken: string;
}): Promise<IgUserProfile> {
  const fields =
    'name,username,profile_pic,is_verified_user,follower_count,is_user_follow_business,is_business_follow_user';
  const data = await igGet<{
    id?: string;
    name?: string;
    username?: string;
    profile_pic?: string;
    is_verified_user?: boolean;
    follower_count?: number;
    is_user_follow_business?: boolean;
    is_business_follow_user?: boolean;
  }>(`${IG_GRAPH_BASE}/${args.igsid}?fields=${fields}`, args.accessToken);

  return {
    igsid: String(data.id ?? args.igsid),
    name: data.name,
    username: data.username,
    profilePictureUrl: data.profile_pic,
    isVerifiedUser: data.is_verified_user,
    followerCount: data.follower_count,
    isUserFollowBusiness: data.is_user_follow_business,
    isBusinessFollowUser: data.is_business_follow_user,
  };
}

// ============================================================
// Webhook subscription
// ============================================================

export async function subscribeToWebhooks(args: {
  igUserId: string;
  accessToken: string;
  fields?: readonly string[];
}): Promise<{ success: boolean }> {
  const data = await igPost<{ success?: boolean }>(
    `${IG_GRAPH_BASE}/${args.igUserId}/subscribed_apps`,
    args.accessToken,
    { subscribed_fields: [...(args.fields ?? IG_WEBHOOK_FIELDS)] },
  );
  return { success: data.success !== false };
}

export async function getSubscribedFields(args: {
  igUserId: string;
  accessToken: string;
}): Promise<string[]> {
  const data = await igGet<{
    data?: Array<{ subscribed_fields?: string[] }>;
  }>(`${IG_GRAPH_BASE}/${args.igUserId}/subscribed_apps`, args.accessToken);
  return data.data?.[0]?.subscribed_fields ?? [];
}

export async function unsubscribeFromWebhooks(args: {
  igUserId: string;
  accessToken: string;
}): Promise<void> {
  await igFetch(
    `${IG_GRAPH_BASE}/${args.igUserId}/subscribed_apps`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
    'Failed to unsubscribe from Instagram webhooks',
  );
}

// ============================================================
// Send API
// ============================================================

export async function sendTextMessage(
  args: BaseSendArgs & { text: string },
): Promise<IgSendResult> {
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: withTag(
      {
        recipient: { id: args.recipientId },
        message: { text: args.text },
      },
      args.tag,
    ),
  });
}

/** `audio` and `file` are accepted by the API but not by every client. */
export type IgMediaType = 'image' | 'video' | 'audio' | 'file';

export async function sendMediaMessage(
  args: BaseSendArgs & { mediaType: IgMediaType; mediaUrl: string },
): Promise<IgSendResult> {
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: withTag(
      {
        recipient: { id: args.recipientId },
        message: {
          attachment: {
            type: args.mediaType,
            payload: { url: args.mediaUrl },
          },
        },
      },
      args.tag,
    ),
  });
}

/** Send previously uploaded media by its reusable attachment id. */
export async function sendAttachmentMessage(
  args: BaseSendArgs & { mediaType: IgMediaType; attachmentId: string },
): Promise<IgSendResult> {
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: withTag(
      {
        recipient: { id: args.recipientId },
        message: {
          attachment: {
            type: args.mediaType,
            payload: { attachment_id: args.attachmentId },
          },
        },
      },
      args.tag,
    ),
  });
}

/** The built-in heart sticker — Instagram's only supported sticker. */
export async function sendHeartSticker(
  args: BaseSendArgs,
): Promise<IgSendResult> {
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: withTag(
      {
        recipient: { id: args.recipientId },
        message: { attachment: { type: 'like_heart' } },
      },
      args.tag,
    ),
  });
}

/**
 * Instagram's reaction vocabulary is a fixed set of names, not
 * arbitrary emoji — the WhatsApp path's "any emoji" model does not
 * carry over. Sending an unlisted value is rejected.
 */
export const IG_REACTIONS = [
  'love',
  'wow',
  'sad',
  'angry',
  'like',
  'laugh',
] as const;

export type IgReaction = (typeof IG_REACTIONS)[number];

export async function sendReaction(args: {
  igUserId: string;
  accessToken: string;
  recipientId: string;
  messageId: string;
  reaction: IgReaction;
}): Promise<IgSendResult> {
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: {
      recipient: { id: args.recipientId },
      sender_action: 'react',
      payload: { message_id: args.messageId, reaction: args.reaction },
    },
  });
}

export async function removeReaction(args: {
  igUserId: string;
  accessToken: string;
  recipientId: string;
  messageId: string;
}): Promise<IgSendResult> {
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: {
      recipient: { id: args.recipientId },
      sender_action: 'unreact',
      payload: { message_id: args.messageId },
    },
  });
}

export interface IgQuickReply {
  /** Max 20 characters — longer titles are rejected by the API. */
  title: string;
  /** Echoed back on the messaging_postbacks webhook. Max 1000 chars. */
  payload: string;
  imageUrl?: string;
}

/**
 * Instagram caps quick replies at 13. Enforced here rather than at the
 * API boundary so a flow that over-produces fails with a message that
 * says what the limit is.
 */
export const IG_LIMITS = {
  quickReplies: 13,
  quickReplyTitleChars: 20,
  buttons: 3,
  buttonTitleChars: 20,
  genericTemplateElements: 10,
  textChars: 1000,
} as const;

export async function sendQuickReplies(
  args: BaseSendArgs & { text: string; quickReplies: IgQuickReply[] },
): Promise<IgSendResult> {
  if (args.quickReplies.length > IG_LIMITS.quickReplies) {
    throw new Error(
      `Instagram allows at most ${IG_LIMITS.quickReplies} quick replies, got ${args.quickReplies.length}`,
    );
  }
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: withTag(
      {
        recipient: { id: args.recipientId },
        messaging_type: 'RESPONSE',
        message: {
          text: args.text,
          quick_replies: args.quickReplies.map((qr) => ({
            content_type: 'text',
            title: qr.title,
            payload: qr.payload,
            ...(qr.imageUrl ? { image_url: qr.imageUrl } : {}),
          })),
        },
      },
      args.tag,
    ),
  });
}

export type IgButton =
  | { type: 'postback'; title: string; payload: string }
  | { type: 'web_url'; title: string; url: string };

export async function sendButtonTemplate(
  args: BaseSendArgs & { text: string; buttons: IgButton[] },
): Promise<IgSendResult> {
  if (args.buttons.length > IG_LIMITS.buttons) {
    throw new Error(
      `Instagram allows at most ${IG_LIMITS.buttons} buttons, got ${args.buttons.length}`,
    );
  }
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: withTag(
      {
        recipient: { id: args.recipientId },
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'button',
              text: args.text,
              buttons: args.buttons,
            },
          },
        },
      },
      args.tag,
    ),
  });
}

export interface IgGenericElement {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  defaultActionUrl?: string;
  buttons?: IgButton[];
}

/** Horizontal card carousel. */
export async function sendGenericTemplate(
  args: BaseSendArgs & { elements: IgGenericElement[] },
): Promise<IgSendResult> {
  if (args.elements.length > IG_LIMITS.genericTemplateElements) {
    throw new Error(
      `Instagram allows at most ${IG_LIMITS.genericTemplateElements} carousel elements, got ${args.elements.length}`,
    );
  }
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: withTag(
      {
        recipient: { id: args.recipientId },
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'generic',
              elements: args.elements.map((el) => ({
                title: el.title,
                ...(el.subtitle ? { subtitle: el.subtitle } : {}),
                ...(el.imageUrl ? { image_url: el.imageUrl } : {}),
                ...(el.defaultActionUrl
                  ? {
                      default_action: {
                        type: 'web_url',
                        url: el.defaultActionUrl,
                      },
                    }
                  : {}),
                ...(el.buttons?.length ? { buttons: el.buttons } : {}),
              })),
            },
          },
        },
      },
      args.tag,
    ),
  });
}

/** Share one of the business's own published posts into the thread. */
export async function sendPublishedPost(
  args: BaseSendArgs & { postId: string },
): Promise<IgSendResult> {
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: withTag(
      {
        recipient: { id: args.recipientId },
        message: {
          attachment: { type: 'MEDIA_SHARE', payload: { id: args.postId } },
        },
      },
      args.tag,
    ),
  });
}

/**
 * Reply to a public comment as a private DM.
 *
 * Addressed by `comment_id` instead of a recipient IGSID — this is what
 * opens a brand-new thread with someone who has never messaged the
 * business. Meta allows exactly ONE per comment, within 7 days of it
 * being posted; a second attempt is an API error, so callers must check
 * `instagram_comments.private_replied_at` first.
 */
export async function sendPrivateReply(args: {
  igUserId: string;
  accessToken: string;
  commentId: string;
  text: string;
}): Promise<IgSendResult> {
  return sendMessagePayload({
    igUserId: args.igUserId,
    accessToken: args.accessToken,
    body: {
      recipient: { comment_id: args.commentId },
      message: { text: args.text },
    },
  });
}

/**
 * Upload media once and reuse it across sends.
 *
 * Worth it for anything sent repeatedly (an automation's welcome
 * image); pointless for a one-off, where sendMediaMessage with a URL is
 * one call instead of two.
 */
export async function uploadAttachment(args: {
  igUserId: string;
  accessToken: string;
  mediaType: IgMediaType;
  mediaUrl: string;
  isReusable?: boolean;
}): Promise<{ attachmentId: string }> {
  const data = await igPost<{ attachment_id: string }>(
    `${IG_GRAPH_BASE}/${args.igUserId}/message_attachments`,
    args.accessToken,
    {
      message: {
        attachment: {
          type: args.mediaType,
          payload: {
            url: args.mediaUrl,
            is_reusable: args.isReusable ?? true,
          },
        },
      },
    },
  );
  return { attachmentId: data.attachment_id };
}

// ============================================================
// Comment moderation
// ============================================================

export interface IgComment {
  id: string;
  text?: string;
  username?: string;
  fromId?: string;
  timestamp?: string;
  parentId?: string;
  hidden?: boolean;
  replies?: IgComment[];
}

interface IgCommentResponse {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
  hidden?: boolean;
  parent_id?: string;
  like_count?: number;
  replies?: { data?: IgCommentResponse[] };
}

function normaliseComment(c: IgCommentResponse, parentId?: string): IgComment {
  return {
    id: c.id,
    text: c.text,
    timestamp: c.timestamp,
    username: c.username ?? c.from?.username,
    fromId: c.from?.id,
    hidden: c.hidden,
    // The nested `replies` edge does not echo parent_id on its members,
    // so it is threaded in from the caller.
    parentId: c.parent_id ?? parentId,
  };
}

/**
 * Every comment on a post, flattened.
 *
 * `/{media}/comments` returns only TOP-LEVEL comments — replies live on
 * a nested `replies` edge. Backfilling without expanding it means a
 * post whose every comment was already answered still syncs as a wall
 * of unanswered work, because the answers were never fetched.
 *
 * Flattened rather than nested because that is what
 * `instagram_comments` is: one row per comment, threaded by
 * `parent_comment_id`.
 */
export async function getMediaComments(args: {
  mediaId: string;
  accessToken: string;
  limit?: number;
}): Promise<IgComment[]> {
  const leafFields = 'id,text,timestamp,username,from,hidden,like_count';
  const fields = `${leafFields},parent_id,replies{${leafFields}}`;
  const params = new URLSearchParams({ fields });
  if (args.limit) params.set('limit', String(args.limit));

  const data = await igGet<{ data?: IgCommentResponse[] }>(
    `${IG_GRAPH_BASE}/${args.mediaId}/comments?${params.toString()}`,
    args.accessToken,
  );

  const flattened: IgComment[] = [];
  for (const comment of data.data ?? []) {
    flattened.push(normaliseComment(comment));
    for (const reply of comment.replies?.data ?? []) {
      flattened.push(normaliseComment(reply, comment.id));
    }
  }
  return flattened;
}

/** Public reply, visible under the post. */
export async function replyToComment(args: {
  commentId: string;
  accessToken: string;
  message: string;
}): Promise<{ id: string }> {
  return igPost<{ id: string }>(
    `${IG_GRAPH_BASE}/${args.commentId}/replies`,
    args.accessToken,
    { message: args.message },
  );
}

/** Hide (or unhide) a comment from public view without deleting it. */
export async function setCommentHidden(args: {
  commentId: string;
  accessToken: string;
  hidden: boolean;
}): Promise<void> {
  await igPost(`${IG_GRAPH_BASE}/${args.commentId}`, args.accessToken, {
    hide: args.hidden,
  });
}

export async function deleteComment(args: {
  commentId: string;
  accessToken: string;
}): Promise<void> {
  await igFetch(
    `${IG_GRAPH_BASE}/${args.commentId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
    'Failed to delete the Instagram comment',
  );
}

// ============================================================
// Media (posts) — read-only; publishing is out of scope
// ============================================================

export interface IgMediaChild {
  id: string;
  mediaType?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
}

export interface IgMedia {
  id: string;
  mediaType?: string;
  mediaProductType?: string;
  permalink?: string;
  /**
   * The small asset. Only VIDEO/REELS populate Meta's `thumbnail_url`,
   * so this falls back to `media_url` to give the grid something to
   * render for images.
   */
  thumbnailUrl?: string;
  /** The full-size asset. Absent on CAROUSEL_ALBUM — use `children`. */
  mediaUrl?: string;
  caption?: string;
  timestamp?: string;
  commentsCount?: number;
  likeCount?: number;
  isCommentEnabled?: boolean;
  /** Carousel items. Empty for every other media type. */
  children?: IgMediaChild[];
}

interface IgMediaResponse {
  id: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
  caption?: string;
  timestamp?: string;
  comments_count?: number;
  like_count?: number;
  is_comment_enabled?: boolean;
  children?: {
    data?: Array<{
      id: string;
      media_type?: string;
      media_url?: string;
      thumbnail_url?: string;
    }>;
  };
}

/**
 * Everything the Posts view renders, in one request.
 *
 * `children{...}` is field expansion, not a second call: a
 * CAROUSEL_ALBUM parent carries no `media_url` of its own, so without
 * it every carousel is a blank tile.
 */
const MEDIA_FIELDS = [
  'id',
  'media_type',
  'media_product_type',
  'permalink',
  'thumbnail_url',
  'media_url',
  'caption',
  'timestamp',
  'comments_count',
  'like_count',
  'is_comment_enabled',
  'children{id,media_type,media_url,thumbnail_url}',
].join(',');

function normaliseMedia(m: IgMediaResponse): IgMedia {
  return {
    id: m.id,
    mediaType: m.media_type,
    mediaProductType: m.media_product_type,
    permalink: m.permalink,
    // Videos expose thumbnail_url; images only media_url. The UI wants
    // one field for the grid, so collapse them here — but keep
    // media_url separately so a detail view can show the real asset.
    thumbnailUrl: m.thumbnail_url ?? m.media_url,
    mediaUrl: m.media_url,
    caption: m.caption,
    timestamp: m.timestamp,
    commentsCount: m.comments_count,
    likeCount: m.like_count,
    isCommentEnabled: m.is_comment_enabled,
    children: m.children?.data?.map((c) => ({
      id: c.id,
      mediaType: c.media_type,
      mediaUrl: c.media_url,
      thumbnailUrl: c.thumbnail_url ?? c.media_url,
    })),
  };
}

export async function listMedia(args: {
  igUserId: string;
  accessToken: string;
  limit?: number;
}): Promise<IgMedia[]> {
  const params = new URLSearchParams({ fields: MEDIA_FIELDS });
  params.set('limit', String(args.limit ?? 25));

  const data = await igGet<{ data?: IgMediaResponse[] }>(
    `${IG_GRAPH_BASE}/${args.igUserId}/media?${params.toString()}`,
    args.accessToken,
  );

  return (data.data ?? []).map(normaliseMedia);
}

/** Re-read one post — used to refresh counts after moderating it. */
export async function getMedia(args: {
  mediaId: string;
  accessToken: string;
}): Promise<IgMedia> {
  const data = await igGet<IgMediaResponse>(
    `${IG_GRAPH_BASE}/${args.mediaId}?fields=${MEDIA_FIELDS}`,
    args.accessToken,
  );
  return normaliseMedia(data);
}

/**
 * Turn commenting on or off for a single post.
 *
 * The blunt instrument for a post that has turned into a pile-on —
 * cheaper than hiding comments one at a time, and reversible. Note the
 * field name asymmetry: Meta *reads* it back as `is_comment_enabled`
 * but *writes* it as `comment_enabled`.
 */
export async function setMediaCommentsEnabled(args: {
  mediaId: string;
  accessToken: string;
  enabled: boolean;
}): Promise<void> {
  await igPost(`${IG_GRAPH_BASE}/${args.mediaId}`, args.accessToken, {
    comment_enabled: args.enabled,
  });
}
