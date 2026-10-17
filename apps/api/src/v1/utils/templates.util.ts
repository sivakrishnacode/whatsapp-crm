import type { message_templates } from '@prisma/client';

/**
 * Public-API shape of a WhatsApp message template (`GET /api/v1/templates`).
 *
 * What an integrator needs to mirror the library on its side: the name and
 * language a send is addressed by, the body with its `{{1}}` / `{{name}}`
 * placeholders, and Meta's review status.
 */
export interface ApiTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  parameter_format: string;
  header: { type: string; text: string | null } | null;
  content: string;
  footer: string | null;
  /**
   * The template's buttons, so an integrator can tell which ones need a
   * send-time `buttonParams` value: a URL whose `url` carries `{{1}}`,
   * a COPY_CODE, or the OTP button of an Authentication template.
   */
  buttons: ApiTemplateButton[];
  rejection_reason: string | null;
  updated_at: string | null;
}

export interface ApiTemplateButton {
  type: string;
  text: string;
  /** URL buttons only. */
  url?: string;
  /** OTP buttons only: COPY_CODE, ONE_TAP or ZERO_TAP. */
  otp_type?: string;
}

export const TEMPLATE_STATUSES = [
  'APPROVED',
  'PENDING',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'DRAFT',
] as const;

export function serializeTemplate(row: message_templates): ApiTemplate {
  const headerType = row.header_type ? String(row.header_type) : null;

  return {
    id: row.id,
    name: row.name,
    language: row.language || 'en_US',
    category: row.category,
    status: (row.status || 'DRAFT').toUpperCase(),
    parameter_format: row.parameter_format || 'POSITIONAL',
    header: headerType
      ? {
          type: headerType,
          text:
            headerType.toUpperCase() === 'TEXT'
              ? (row.header_content ?? null)
              : null,
        }
      : null,
    content: row.body_text ?? '',
    footer: row.footer_text ?? null,
    buttons: serializeButtons(row.buttons),
    rejection_reason: row.rejection_reason ?? null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

/**
 * `message_templates.buttons` is untyped Json, so anything that is not a
 * `{type, text}` object is skipped rather than passed through.
 */
function serializeButtons(raw: unknown): ApiTemplateButton[] {
  if (!Array.isArray(raw)) return [];
  const out: ApiTemplateButton[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const b = entry as Record<string, unknown>;
    if (typeof b.type !== 'string') continue;
    const button: ApiTemplateButton = {
      type: b.type,
      text: typeof b.text === 'string' ? b.text : '',
    };
    if (b.type === 'URL' && typeof b.url === 'string') button.url = b.url;
    if (b.type === 'OTP' && typeof b.otp_type === 'string') {
      button.otp_type = b.otp_type;
    }
    out.push(button);
  }
  return out;
}

/**
 * The optional `?status=` filter, upper-cased and checked against the known
 * statuses. Returns `undefined` for "no filter" and `null` for an unknown value.
 */
export function normalizeTemplateStatus(
  input: unknown,
): string | null | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string') return null;

  const status = input.trim().toUpperCase();

  return (TEMPLATE_STATUSES as readonly string[]).includes(status)
    ? status
    : null;
}
