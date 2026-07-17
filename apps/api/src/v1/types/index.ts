export type TemplateButton =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string; example?: string }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string }
  | { type: 'COPY_CODE'; text: string; example: string };

export interface TemplateSampleValues {
  body?: string[];
  header?: string[];
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
  header_type?: 'text' | 'image' | 'video' | 'document';
  header_content?: string;
  header_handle?: string;
  header_media_url?: string;
  buttons?: TemplateButton[];
  sample_values?: TemplateSampleValues;
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
