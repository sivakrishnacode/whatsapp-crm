export type TemplateButton =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string; example?: string }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string }
  | { type: 'COPY_CODE'; text: string; example: string };

export interface TemplateSampleValues {
  body?: string[];
  header?: string[];
}

/**
 * Meta's `parameter_format`. POSITIONAL is the classic `{{1}}` scheme;
 * NAMED swaps it for `{{customer_name}}`. A template is one or the
 * other — Meta rejects a mix — and the format is fixed once created.
 */
export type TemplateParameterFormat = 'POSITIONAL' | 'NAMED';

/**
 * One card of a CAROUSEL template. Meta requires every card in a
 * carousel to share the same shape: same header format, and the same
 * number and types of buttons. Cards have no footer.
 */
export interface TemplateCard {
  header_format: 'image' | 'video';
  /** Resumable-Upload handle — what Meta wants for card media at creation. */
  header_handle?: string;
  /** Public sample URL. Also the send-time media source for this card. */
  header_media_url?: string;
  body_text: string;
  /** Sample values for the card body's variables, in placeholder order. */
  body_samples?: string[];
  buttons: TemplateButton[];
}

export type MessageTemplateStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'PAUSED'
  | 'DISABLED'
  | 'IN_APPEAL'
  | 'PENDING_DELETION';

export interface MessageTemplate {
  id: string;
  user_id: string;
  name: string;
  category: 'Marketing' | 'Utility' | 'Authentication';
  language?: string;
  header_type?: 'text' | 'image' | 'video' | 'document' | 'location';
  header_content?: string;
  header_handle?: string;
  header_media_url?: string;
  buttons?: TemplateButton[];
  sample_values?: TemplateSampleValues;
  /** Defaults to POSITIONAL when absent — every pre-existing row. */
  parameter_format?: TemplateParameterFormat;
  /** Non-empty only for CAROUSEL templates. */
  cards?: TemplateCard[];
  status?: MessageTemplateStatus;
  meta_template_id?: string;
  rejection_reason?: string;
  quality_score?: 'GREEN' | 'YELLOW' | 'RED';
  submission_error?: string;
  last_submitted_at?: string;
  created_at: Date | string;
  body_text: string;
  footer_text?: string;
}
