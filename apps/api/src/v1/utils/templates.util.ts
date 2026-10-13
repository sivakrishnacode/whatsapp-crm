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
  rejection_reason: string | null;
  updated_at: string | null;
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
    rejection_reason: row.rejection_reason ?? null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  };
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
