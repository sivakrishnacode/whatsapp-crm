/**
 * Wire shapes shared by the widget's components.
 *
 * Hand-written rather than imported from `@/types`: those are the
 * dashboard's models, carrying fields (assigned agent, account id, unread
 * counts) that must never reach a visitor's browser. Keeping the widget's
 * view of a message separate is what makes it obvious when a field is
 * being added to a payload the public can read.
 */

export type WidgetSenderType = 'customer' | 'agent' | 'ai' | 'system';

export interface WidgetMessage {
  id: string;
  sender_type: WidgetSenderType;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  interactive_reply_id: string | null;
  metadata: Record<string, unknown> | null;
  status?: string;
  created_at: string;
  /**
   * Client-only: set on a message we have posted but not yet had
   * acknowledged. Lets the bubble render immediately and reconcile when
   * the server echo arrives over the stream.
   */
  pending?: boolean;
  /** Client-only: the POST failed and the visitor can retry. */
  failed?: boolean;
}

export interface WidgetAppearance {
  accent: string;
  position: 'left' | 'right';
  theme: 'light' | 'dark' | 'auto';
  launcher_icon: string;
  title: string;
  subtitle: string;
  greeting: string | null;
  teaser: string | null;
  teaser_delay_seconds: number;
}

export interface WidgetBootstrap {
  appearance: WidgetAppearance;
  locale: string;
  show_branding: boolean;
  ai_enabled: boolean;
  is_open: boolean;
  offline: boolean;
  /**
   * Inlined rather than referenced by id: the widget needs these to render
   * its first screen, and a second round trip before anything appears would
   * undercut the one thing this channel is supposed to do — open instantly.
   *
   * Null means the account configured no form. Pre-chat then falls back to
   * the built-in name/phone/email screen; offline lets the visitor message
   * freely and it waits in the inbox.
   */
  prechat_form: WidgetPublicForm | null;
  offline_form: WidgetPublicForm | null;
}

/**
 * Structurally the `PublicForm` the form renderer consumes. Redeclared here
 * rather than imported so `widget-types` stays the single description of
 * what crosses the public boundary — if the dashboard's form model grows a
 * field, it does not silently become part of a world-readable payload.
 */
export interface WidgetPublicForm {
  id: string;
  name: string;
  description?: string | null;
  slug: string;
  kind: 'form' | 'booking';
  fields: Array<Record<string, unknown>>;
  settings: { submit_label: string; honeypot: boolean };
}

export interface WidgetButton {
  id: string;
  title: string;
}

/** A `content_type: 'buttons'` message's `metadata`. */
export interface WidgetButtonsMeta {
  buttons?: WidgetButton[];
  header_text?: string;
  footer_text?: string;
}

/** A `content_type: 'list'` message's `metadata`. */
export interface WidgetListMeta {
  button_label?: string;
  header_text?: string;
  footer_text?: string;
  sections?: Array<{
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
}

/** A `content_type: 'form' | 'booking'` message's `metadata`. */
export interface WidgetCardMeta {
  form_id?: string;
  booking_id?: string;
  url?: string;
}
