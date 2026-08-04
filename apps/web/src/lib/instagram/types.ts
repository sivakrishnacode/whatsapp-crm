/**
 * Wire types for the Instagram Posts + Comments views.
 *
 * These mirror `GET /instagram/media` and `GET /instagram/comments`
 * (apps/api/src/instagram/controllers/instagram-comments.controller.ts).
 * Fields are snake_case because they come straight off the Prisma rows —
 * renaming them in the controller would only add a mapping layer that
 * has to be kept in sync with the schema.
 */

export interface IgMediaChild {
  id: string;
  mediaType?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
}

export interface IgMedia {
  id: string;
  ig_media_id: string;
  media_type: string | null;
  media_product_type: string | null;
  permalink: string | null;
  thumbnail_url: string | null;
  media_url: string | null;
  caption: string | null;
  like_count: number | null;
  /** Instagram's own total. Not the moderation backlog. */
  comments_count: number | null;
  /** `null` means "not synced yet" — must not render as "off". */
  is_comment_enabled: boolean | null;
  children: IgMediaChild[] | null;
  posted_at: string | null;
  synced_at: string;
  /** Local: comments still marked `open`. This is the work outstanding. */
  open_comments: number;
}

export interface IgMediaListResponse {
  media: IgMedia[];
  total: number;
  limit: number;
  offset: number;
  stats: {
    posts: number;
    open_comments: number;
    likes: number;
    comments: number;
  };
}

export type IgCommentStatus = 'open' | 'replied' | 'hidden' | 'deleted';

export interface IgCommentReply {
  id: string;
  ig_comment_id: string;
  from_username: string | null;
  text: string | null;
  is_from_business: boolean;
  commented_at: string | null;
}

export interface IgComment {
  id: string;
  ig_comment_id: string;
  ig_media_id: string;
  parent_comment_id: string | null;
  from_username: string | null;
  from_igsid: string | null;
  contact_id: string | null;
  text: string | null;
  status: IgCommentStatus;
  commented_at: string | null;
  private_replied_at: string | null;
  private_reply_conversation_id: string | null;
  media: IgMedia | null;
  /** Answers already posted under this comment, oldest first. */
  replies: IgCommentReply[];
  contact: { id: string; name: string | null } | null;
  /** Set when a Comment Funnel answered this comment. See IgFunnelRun. */
  funnel_run: IgFunnelRun | null;
}

/** awaiting_optin → awaiting_follow → delivered. `failed` is terminal. */
export type IgFunnelRunState =
  | 'awaiting_optin'
  | 'awaiting_follow'
  | 'delivered'
  | 'failed';

/**
 * One commenter's journey through a funnel, as far as the queue needs
 * to know: which funnel, how far they got, and where the DM thread is.
 */
export interface IgFunnelRun {
  ig_comment_id: string;
  state: IgFunnelRunState;
  /**
   * `is_user_follow_business` when the gate was evaluated. NULL means it
   * was never determined — the lookup failed, or the gate was off.
   */
  was_following: boolean | null;
  delivered_at: string | null;
  conversation_id: string | null;
  funnel: { id: string; name: string } | null;
}

export interface IgCommentListResponse {
  comments: IgComment[];
  total: number;
  /** Per-status tallies for the tab labels, plus `all`. */
  counts: Partial<Record<IgCommentStatus | 'all', number>>;
  limit: number;
  offset: number;
}

// ============================================================
// Comment → DM funnels
// ============================================================

export interface IgRewardButton {
  label: string;
  url: string;
}

/**
 * One comment → DM funnel, as `GET /instagram/funnels` returns it.
 *
 * Mirrors `instagram_comment_funnels`. The naming is the funnel's, not
 * the UI's — the Posts page calls this an "automation" because that is
 * what a merchant looking at a post is thinking about, but there is only
 * one row type underneath and pretending otherwise would need a mapping
 * layer in both directions.
 */
export interface IgFunnel {
  id: string;
  name: string;
  /** `null` scopes the funnel to every post, present and future. */
  ig_media_id: string | null;
  /** Empty = every comment matches. Case-insensitive substring. */
  keywords: string[];
  optin_text: string;
  optin_button_label: string;
  follow_gate_enabled: boolean;
  follow_ask_text: string | null;
  follow_button_label: string;
  reward_text: string;
  reward_buttons: IgRewardButton[] | null;
  /** Rotated one per match, so a busy post is not full of one sentence. */
  public_reply_texts: string[];
  /** 0 = answer on the webhook path. See REPLY_DELAY_OPTIONS. */
  reply_delay_seconds: number;
  is_active: boolean;
  matched_count: number;
  delivered_count: number;
}

export interface IgFunnelListResponse {
  funnels: IgFunnel[];
}

export interface IgFunnelEnabledResponse {
  /** The account master switch. Off means no funnel runs at all. */
  enabled: boolean;
  /** False until Instagram is connected — the switch cannot be armed. */
  connected: boolean;
  /** The business's own handle, for the editor's reply preview. */
  username: string | null;
}

/** A funnel body on the way to the API. `id` present = PATCH. */
export type IgFunnelDraft = Omit<
  IgFunnel,
  'id' | 'matched_count' | 'delivered_count'
> & { id?: string };
