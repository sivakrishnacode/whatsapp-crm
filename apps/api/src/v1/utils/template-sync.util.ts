/**
 * Shared helpers for syncing Meta template data into the local DB.
 * Used by WhatsappTemplatesController.sync().
 */

export interface MetaButton {
  type: string;
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
}

export interface MetaTemplateComponent {
  type: string;
  text?: string;
  format?: string;
  buttons?: MetaButton[];
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

export function normalizeCategory(
  meta: string,
): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase();
  if (upper === 'UTILITY') return 'Utility';
  if (upper === 'AUTHENTICATION') return 'Authentication';
  return 'Marketing';
}

export function normalizeQualityScore(
  raw: { score?: string } | string | null | undefined,
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score =
    typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null;
  if (!score) return null;
  const upper = score.toUpperCase();
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED'
    ? (upper as 'GREEN' | 'YELLOW' | 'RED')
    : null;
}

export function parseTemplateButtons(
  metaButtons: MetaButton[] | undefined,
): Array<Record<string, any>> {
  if (!metaButtons?.length) return [];
  const out: Array<Record<string, any>> = [];
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text });
        break;
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        });
        break;
      case 'PHONE_NUMBER':
        out.push({
          type: 'PHONE_NUMBER',
          text: b.text,
          phone_number: b.phone_number ?? '',
        });
        break;
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example)
            ? b.example[0] ?? ''
            : b.example ?? '',
        });
        break;
    }
  }
  return out;
}

export function extractTemplateSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): Record<string, any> | null {
  const bodySample = body?.example?.body_text?.[0];
  const headerSample = header?.example?.header_text;
  if (!bodySample?.length && !headerSample?.length) return null;
  const sv: Record<string, any> = {};
  if (bodySample?.length) sv.body = bodySample;
  if (headerSample?.length) sv.header = headerSample;
  return sv;
}

const STATUS_MAP: Record<string, string> = {
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  REJECTED: 'REJECTED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  IN_APPEAL: 'IN_APPEAL',
  PENDING_DELETION: 'PENDING_DELETION',
  DRAFT: 'DRAFT',
};

export function normalizeTemplateStatus(status: string): string {
  return STATUS_MAP[status?.toUpperCase()] ?? 'PENDING';
}
