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

interface MetaNamedParamExample {
  param_name?: string;
  example?: string;
}

export interface MetaTemplateComponent {
  type: string;
  text?: string;
  format?: string;
  buttons?: MetaButton[];
  /** Present on the CAROUSEL component only. */
  cards?: { components?: MetaTemplateComponent[] }[];
  example?: {
    header_text?: string[];
    header_text_named_params?: MetaNamedParamExample[];
    header_handle?: string[];
    header_url?: string[];
    body_text?: string[][];
    body_text_named_params?: MetaNamedParamExample[];
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
    ? upper
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
            ? (b.example[0] ?? '')
            : (b.example ?? ''),
        });
        break;
    }
  }
  return out;
}

/**
 * NAMED templates return their examples as {param_name, example} pairs.
 * We store only the ordered values — the names live in the template text
 * and are re-derived from it — so both shapes collapse to one array.
 */
function namedExamplesToValues(
  named: MetaNamedParamExample[] | undefined,
): string[] {
  if (!named?.length) return [];
  return named.map((p) => p.example ?? '');
}

export function extractTemplateSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): Record<string, any> | null {
  const bodySample =
    body?.example?.body_text?.[0] ??
    namedExamplesToValues(body?.example?.body_text_named_params);
  const headerSample =
    header?.example?.header_text ??
    namedExamplesToValues(header?.example?.header_text_named_params);
  if (!bodySample?.length && !headerSample?.length) return null;
  const sv: Record<string, any> = {};
  if (bodySample?.length) sv.body = bodySample;
  if (headerSample?.length) sv.header = headerSample;
  return sv;
}

/** Meta header formats we can round-trip into `header_type`. */
const HEADER_FORMATS = new Set([
  'TEXT',
  'IMAGE',
  'VIDEO',
  'DOCUMENT',
  'LOCATION',
]);

export function parseHeaderType(
  header: MetaTemplateComponent | undefined,
): string | null {
  const format = header?.format?.toUpperCase();
  return format && HEADER_FORMATS.has(format) ? format.toLowerCase() : null;
}

export function normalizeParameterFormat(
  raw: string | null | undefined,
): 'POSITIONAL' | 'NAMED' {
  return raw?.toUpperCase() === 'NAMED' ? 'NAMED' : 'POSITIONAL';
}

/**
 * Flatten Meta's CAROUSEL component into our `cards` JSONB shape.
 *
 * Cards whose header format isn't image or video are dropped rather
 * than stored: Meta only creates those two, so anything else means a
 * shape we can't render or re-submit, and a half-parsed card would fail
 * validation later with a confusing message.
 */
export function parseCarouselCards(
  carousel: MetaTemplateComponent | undefined,
): Array<Record<string, any>> {
  if (!carousel?.cards?.length) return [];
  const out: Array<Record<string, any>> = [];
  for (const card of carousel.cards) {
    const components = card.components ?? [];
    const header = components.find((c) => c.type?.toUpperCase() === 'HEADER');
    const body = components.find((c) => c.type?.toUpperCase() === 'BODY');
    const buttons = components.find((c) => c.type?.toUpperCase() === 'BUTTONS');

    const format = header?.format?.toUpperCase();
    if (format !== 'IMAGE' && format !== 'VIDEO') continue;

    const samples =
      body?.example?.body_text?.[0] ??
      namedExamplesToValues(body?.example?.body_text_named_params);

    out.push({
      header_format: format.toLowerCase(),
      header_handle: header?.example?.header_handle?.[0] ?? null,
      header_media_url: header?.example?.header_url?.[0] ?? null,
      body_text: body?.text ?? '',
      body_samples: samples.length ? samples : [],
      buttons: parseTemplateButtons(buttons?.buttons),
    });
  }
  return out;
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
