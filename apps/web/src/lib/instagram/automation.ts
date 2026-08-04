import type { IgFunnel, IgFunnelDraft, IgMedia } from './types';

/**
 * Post-type tabs for the Posts grid.
 *
 * Exactly the values `media_product_type` can hold, because the filter
 * is a straight equality match in the API (`?type=`). No tab exists that
 * cannot be answered — a "Collabs" or "Live" tab that always renders an
 * empty state teaches the merchant that the tabs are unreliable, which
 * costs more than the missing filter.
 *
 * "Posts" rather than "Feed posts": FEED is Instagram's word for its own
 * plumbing, and to a merchant a feed post is just a post.
 */
export const POST_TYPE_TABS = [
  { value: 'all', label: 'All' },
  { value: 'FEED', label: 'Posts' },
  { value: 'REELS', label: 'Reels' },
  { value: 'STORY', label: 'Stories' },
  { value: 'AD', label: 'Ads' },
] as const;

export type PostTypeTab = (typeof POST_TYPE_TABS)[number]['value'];

/**
 * How long a funnel waits before answering.
 *
 * Presets, not a number input: the useful range is "instantly" to "long
 * enough not to look instant", and the difference between 45 and 50
 * seconds is not a decision worth making. The API accepts anything up to
 * 3600, so a preset can be added here without a backend change.
 */
export const REPLY_DELAY_OPTIONS = [
  { value: 0, label: 'Immediate' },
  { value: 10, label: '10 sec' },
  { value: 30, label: '30 sec' },
  { value: 60, label: '1 min' },
] as const;

/** Mirrors instagram_comment_funnels_public_replies_chk. */
export const MAX_PUBLIC_REPLY_VARIANTS = 10;
/** Meta renders at most 3 buttons on a button template. */
export const MAX_REWARD_BUTTONS = 3;
/** Meta's cap on a quick-reply / button title. */
export const BUTTON_LABEL_CHARS = 20;
/** Meta's cap on a DM body. */
export const MESSAGE_CHARS = 1000;

/**
 * Starting point for a new post automation.
 *
 * Pre-filled rather than blank because the wording is the hard part of
 * this feature and a merchant staring at five empty textareas writes
 * worse copy than one editing a working example. Every default is
 * something we would be happy to see sent.
 *
 * `is_active: false` regardless — see `armedByDefault` below.
 */
export function blankAutomation(media?: IgMedia | null): IgFunnelDraft {
  return {
    name: media ? automationName(media) : 'All posts',
    ig_media_id: media?.ig_media_id ?? null,
    keywords: [],
    optin_text: 'Thanks for commenting! Tap below and I’ll send it over ✨',
    optin_button_label: 'Send me the link',
    follow_gate_enabled: false,
    follow_ask_text:
      'One thing — follow me first and I’ll send it straight over 🎉',
    follow_button_label: 'I followed you! ✅',
    reward_text: 'Here you go 🎁',
    reward_buttons: [],
    public_reply_texts: ['Check your DMs 📩'],
    reply_delay_seconds: 0,
    is_active: false,
  };
}

/**
 * A name a merchant will recognise in a list, derived from the post.
 *
 * The caption's first line, because that is how people refer to their
 * own posts. Falls back to the date — never to the media id, which is an
 * 18-digit number that identifies nothing to a human.
 */
export function automationName(media: IgMedia): string {
  const firstLine = media.caption?.split('\n')[0]?.trim();
  if (firstLine) {
    return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
  }
  const posted = media.posted_at ? new Date(media.posted_at) : null;
  if (posted && !Number.isNaN(posted.getTime())) {
    return `Post from ${posted.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    })}`;
  }
  return 'Untitled post';
}

/**
 * A saved funnel as an editable draft.
 *
 * Drops the read-only counters and normalises the two nullable JSON
 * columns, so the editor never has to guard `reward_buttons` being null
 * on a row written before it had a default.
 */
export function draftFromFunnel(funnel: IgFunnel): IgFunnelDraft {
  return {
    id: funnel.id,
    name: funnel.name,
    ig_media_id: funnel.ig_media_id,
    keywords: funnel.keywords ?? [],
    optin_text: funnel.optin_text,
    optin_button_label: funnel.optin_button_label,
    follow_gate_enabled: funnel.follow_gate_enabled,
    follow_ask_text: funnel.follow_ask_text,
    follow_button_label: funnel.follow_button_label,
    reward_text: funnel.reward_text,
    reward_buttons: funnel.reward_buttons ?? [],
    public_reply_texts: funnel.public_reply_texts ?? [],
    reply_delay_seconds: funnel.reply_delay_seconds ?? 0,
    is_active: funnel.is_active,
  };
}

/** The account-wide funnel, if one exists. `ig_media_id === null`. */
export function globalFunnel(funnels: readonly IgFunnel[]): IgFunnel | null {
  return funnels.find((f) => f.ig_media_id === null) ?? null;
}

/** The funnel scoped to exactly this post, if one exists. */
export function postFunnel(
  funnels: readonly IgFunnel[],
  media: Pick<IgMedia, 'ig_media_id'>
): IgFunnel | null {
  return funnels.find((f) => f.ig_media_id === media.ig_media_id) ?? null;
}

export type AutomationState =
  /** Nothing covers this post. */
  | 'none'
  /** A funnel covers it and is running. */
  | 'live'
  /** A funnel covers it but its own switch is off. */
  | 'paused'
  /** The funnel is on, but the account master switch is off. */
  | 'blocked';

export interface PostAutomation {
  state: AutomationState;
  /** The funnel the badge is describing, or null when `state` is 'none'. */
  funnel: IgFunnel | null;
  /**
   * True when the covering funnel is the account-wide one rather than a
   * funnel for this post. The distinction matters: editing a global
   * funnel from a post's editor would silently change every other post.
   */
  viaGlobal: boolean;
}

/**
 * What the grid should say about one post.
 *
 * Resolution mirrors the server's `matchFunnel` exactly — post-scoped
 * beats account-wide, and both must be `is_active` to be considered —
 * because a badge that disagrees with what actually runs is worse than
 * no badge. The one thing it adds is `viaGlobal`, which the server has no
 * reason to care about and the UI cannot do without: editing a global
 * funnel from one post's editor would silently change every other post.
 *
 * The subtle case is a post whose own funnel is paused while the
 * account-wide one is live. The server filters candidates on `is_active`,
 * so the global funnel takes the comment — and so this reports 'live',
 * not 'paused'. `state` always describes what will actually happen to the
 * next comment, never what is merely configured.
 */
export function postAutomation(
  funnels: readonly IgFunnel[],
  media: Pick<IgMedia, 'ig_media_id'>,
  masterEnabled: boolean
): PostAutomation {
  const own = postFunnel(funnels, media);
  const global = globalFunnel(funnels);

  // What the server would pick: the post's own funnel if it is armed,
  // otherwise the account-wide one if that is.
  const running = own?.is_active ? own : global?.is_active ? global : null;

  if (running) {
    return {
      state: masterEnabled ? 'live' : 'blocked',
      funnel: running,
      viaGlobal: running === global && own?.is_active !== true,
    };
  }

  // Nothing is armed. Prefer the post's own funnel for the badge — it is
  // the one the merchant will want to turn back on.
  const configured = own ?? global;
  if (configured) {
    return {
      state: 'paused',
      funnel: configured,
      viaGlobal: configured === global && own == null,
    };
  }

  return { state: 'none', funnel: null, viaGlobal: false };
}

/** Short badge wording for `postAutomation().state`. */
export function automationStateLabel(state: AutomationState): string {
  switch (state) {
    case 'live':
      return 'Automated';
    case 'paused':
      return 'Paused';
    case 'blocked':
      return 'Switched off';
    case 'none':
      return 'Not automated';
  }
}

/**
 * What the post's action button should say.
 *
 * Three words, because there are three genuinely different actions.
 * "Automate" on a post the all-posts automation already answers reads as
 * a lie — that post IS automated. What the button does there is give it
 * its own settings, overriding the catch-all, which is "Customise".
 */
export function automationActionLabel(automation: PostAutomation): string {
  if (automation.state === 'none') return 'Automate';
  return automation.viaGlobal ? 'Customise' : 'Edit';
}

/** One-line explanation for the badge's tooltip. */
export function automationStateHint(automation: PostAutomation): string {
  const via = automation.viaGlobal ? ' by the all-posts automation' : '';
  switch (automation.state) {
    case 'live':
      return `Comments on this post are answered${via || ' automatically'}.`;
    case 'paused':
      return automation.viaGlobal
        ? 'The all-posts automation is set up but turned off.'
        : 'This post has an automation, but it is turned off.';
    case 'blocked':
      return 'Set up and armed, but comment automations are switched off for the whole account.';
    case 'none':
      return 'Comments on this post are not answered automatically.';
  }
}

/**
 * What the trigger reads as in one phrase.
 *
 * Used in the editor header and on the card, so the merchant can tell
 * "replies to everyone" from "replies to LINK" without opening anything.
 */
export function triggerSummary(keywords: readonly string[]): string {
  if (keywords.length === 0) return 'any comment';
  if (keywords.length <= 3) return keywords.join(', ');
  return `${keywords.slice(0, 2).join(', ')} +${keywords.length - 2} more`;
}

/**
 * Strip the rows a merchant abandoned, and refuse the ones that would
 * fail at send time.
 *
 * Returns a message for the first real problem, or null to save. Runs
 * before the request so the answer is a sentence about their wording
 * rather than a 400 quoting a DTO field name.
 *
 * `keywordsRequired` comes from the editor's trigger mode, which the draft
 * cannot express: an empty `keywords` means "any comment" to the server,
 * so a merchant who picked "Specific words" and typed nothing would save a
 * funnel that answers everything — the opposite of what the UI said.
 */
export function validateAutomation(
  draft: IgFunnelDraft,
  opts: { keywordsRequired?: boolean } = {}
): string | null {
  if (!draft.name.trim()) return 'Give this automation a name.';
  if (opts.keywordsRequired && draft.keywords.length === 0)
    return 'Add at least one trigger word, or switch to “Any comment”.';
  if (!draft.optin_text.trim())
    return 'The opening DM needs something to say.';
  if (!draft.optin_button_label.trim())
    return 'The opening DM needs a button label.';
  if (!draft.reward_text.trim())
    return 'Add the message that delivers the link.';
  if (draft.follow_gate_enabled && !draft.follow_ask_text?.trim())
    return 'Write the message that asks people to follow, or turn the follow ask off.';

  const buttons = (draft.reward_buttons ?? []).filter(
    (b) => b.label.trim() || b.url.trim()
  );
  for (const button of buttons) {
    if (!button.label.trim()) return 'A link button is missing its label.';
    if (!/^https?:\/\//i.test(button.url.trim()))
      return `“${button.label.trim()}” needs a link starting with http:// or https://`;
  }

  return null;
}

/**
 * The draft as the API wants it.
 *
 * Half-typed link buttons and blank reply variants are dropped rather
 * than sent: the API rejects them, and losing a whole save to a row the
 * merchant had already given up on is a miserable way to find out.
 */
export function automationBody(draft: IgFunnelDraft) {
  return {
    name: draft.name.trim(),
    ig_media_id: draft.ig_media_id || null,
    keywords: draft.keywords,
    optin_text: draft.optin_text,
    optin_button_label: draft.optin_button_label,
    follow_gate_enabled: draft.follow_gate_enabled,
    // Sent even when the gate is off. The DB only requires the text when
    // the gate is on, and blanking it would mean a merchant who toggles
    // the gate off and on again has to rewrite what they already wrote.
    follow_ask_text: draft.follow_ask_text?.trim() || null,
    follow_button_label: draft.follow_button_label,
    reward_text: draft.reward_text,
    reward_buttons: (draft.reward_buttons ?? []).filter(
      (b) => b.label.trim() && b.url.trim()
    ),
    public_reply_texts: draft.public_reply_texts
      .map((t) => t.trim())
      .filter(Boolean),
    reply_delay_seconds: draft.reply_delay_seconds,
    is_active: draft.is_active,
  };
}
