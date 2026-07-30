import type {
  MessageTemplate,
  TemplateButton,
  TemplateCard,
  TemplateParameterFormat,
  TemplateSampleValues,
} from '../types/index';

export const TEMPLATE_LIMITS = {
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
  buttonTextMaxLength: 25,
  maxButtonsTotal: 10,
  maxUrlButtons: 2,
  maxPhoneButtons: 1,
  maxCopyCodeButtons: 1,
  nameRegex: /^[a-z0-9_]{1,512}$/,
  /** Meta: a carousel carries 1-10 cards. */
  maxCarouselCards: 10,
  /** Meta: card bodies are much tighter than the outer 1024. */
  cardBodyMaxLength: 160,
  /** Meta: each card takes 1-2 buttons. */
  maxCardButtons: 2,
  /**
   * NAMED parameter names: lowercase letters, digits, underscore. The
   * length cap is ours, not Meta's — no published limit exists, and a
   * name this long is a mistake rather than a use case.
   */
  namedParamRegex: /^[a-z_][a-z0-9_]{0,63}$/,
} as const;

export interface TemplatePayload {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  header_type?: MessageTemplate['header_type'];
  header_content?: string;
  header_media_url?: string;
  header_handle?: string;
  body_text: string;
  footer_text?: string;
  buttons?: TemplateButton[];
  sample_values?: TemplateSampleValues;
  /** Absent means POSITIONAL — the only scheme that existed before. */
  parameter_format?: TemplateParameterFormat;
  /** Present and non-empty turns this into a CAROUSEL template. */
  cards?: TemplateCard[];
}

/** Absent/garbage → POSITIONAL, so old payloads keep working untouched. */
export function resolveParameterFormat(
  format: TemplateParameterFormat | undefined,
): TemplateParameterFormat {
  return format === 'NAMED' ? 'NAMED' : 'POSITIONAL';
}

export function validateTemplateName(name: string): void {
  if (!name) throw new Error('Template name is required.');
  if (!TEMPLATE_LIMITS.nameRegex.test(name)) {
    throw new Error(
      'Template name must use only lowercase letters, digits, and underscores (1-512 chars).',
    );
  }
}

export function extractVariableIndices(text: string): number[] {
  const matches = text.matchAll(/\{\{(\d+)\}\}/g);
  const set = new Set<number>();
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Named placeholders (`{{customer_name}}`) in order of FIRST appearance,
 * deduplicated. Order matters: it is the whole mapping between a
 * template's names and its ordered `sample_values.body` array, which is
 * why nothing extra is persisted per variable.
 *
 * Purely-numeric placeholders are skipped here rather than rejected —
 * they mean "this template is positional", which `assertFormatMatches`
 * reports with a far more useful message than a regex failure.
 */
export function extractNamedVariables(text: string): string[] {
  const matches = text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const name = m[1];
    if (/^\d+$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function assertContiguous(indices: number[], where: string): void {
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i + 1) {
      throw new Error(
        `${where} variables must be contiguous starting at {{1}} — found ${indices
          .map((n) => `{{${n}}}`)
          .join(', ')}.`,
      );
    }
  }
}

/**
 * A template declares one parameter scheme for all of its text. Meta
 * rejects a mix outright, so catch it here where we can name the
 * offending placeholder and say which way to resolve it.
 */
function assertFormatMatches(
  text: string,
  format: TemplateParameterFormat,
  where: string,
): void {
  if (format === 'NAMED') {
    const positional = extractVariableIndices(text);
    if (positional.length > 0) {
      throw new Error(
        `${where} uses the positional variable {{${positional[0]}}}, but this template uses named parameters — rename it to {{like_this}}.`,
      );
    }
    return;
  }
  const named = extractNamedVariables(text);
  if (named.length > 0) {
    throw new Error(
      `${where} uses the named variable {{${named[0]}}}, but this template uses positional parameters — switch the template to named parameters or use {{1}}, {{2}}, ….`,
    );
  }
}

/**
 * Validate the placeholders in one piece of template text and return
 * them as tokens: `['1','2']` for POSITIONAL, `['name','order']` for
 * NAMED. Callers only ever need the count and the order, so a single
 * token list serves both schemes.
 */
export function validateTextVariables(
  text: string,
  format: TemplateParameterFormat,
  where: string,
): string[] {
  assertFormatMatches(text, format, where);

  if (format === 'NAMED') {
    const names = extractNamedVariables(text);
    for (const name of names) {
      if (!TEMPLATE_LIMITS.namedParamRegex.test(name)) {
        throw new Error(
          `${where} variable {{${name}}} is not a valid named parameter — use lowercase letters, digits, and underscores, starting with a letter (Meta rule).`,
        );
      }
    }
    return names;
  }

  const indices = extractVariableIndices(text);
  assertContiguous(indices, where);
  return indices.map(String);
}

/**
 * Text that Meta allows exactly one variable in — a TEXT header and a
 * URL button suffix. Positional single-variable slots have their own
 * numbering that always starts over at {{1}}, so a contiguity error
 * would be the wrong thing to report here.
 */
export function validateSingleVariableText(
  text: string,
  format: TemplateParameterFormat,
  where: string,
): string[] {
  assertFormatMatches(text, format, where);

  if (format === 'NAMED') {
    const names = validateTextVariables(text, format, where);
    if (names.length > 1) {
      throw new Error(
        `${where} can have at most one variable (Meta rule) — found ${names.length}.`,
      );
    }
    return names;
  }

  const indices = extractVariableIndices(text);
  if (indices.length > 1) {
    throw new Error(
      `${where} can have at most one variable (Meta rule) — found ${indices.length}.`,
    );
  }
  if (indices.length === 1 && indices[0] !== 1) {
    throw new Error(`${where} variable must be {{1}} (Meta rule).`);
  }
  return indices.map(String);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Meta rejects a body whose first or last element is a variable, with
 * "Leading or trailing params not allowed / Variables can't be at the
 * start or end of the template."
 *
 * Verified against the live API, including the non-obvious part:
 * trailing punctuation does not save it. `"Total comes to {{1}}."` is
 * rejected exactly like `"Total comes to {{1}}"`, so the test is whether
 * real word characters surround the placeholders — not whether the
 * string merely ends with something else.
 *
 * Headers are deliberately exempt: `"New in: {{1}}"` is accepted, so the
 * rule is body-only.
 */
function assertNoEdgeVariables(bodyText: string): void {
  const first = bodyText.search(/\{\{/);
  if (first === -1) return;
  const lastClose = bodyText.lastIndexOf('}}');

  if (!WORD_CHAR.test(bodyText.slice(0, first))) {
    throw new Error(
      "Body can't start with a variable (Meta rule) — put some text before it.",
    );
  }
  if (!WORD_CHAR.test(bodyText.slice(lastClose + 2))) {
    throw new Error(
      "Body can't end with a variable (Meta rule) — add text after it. Punctuation alone isn't enough.",
    );
  }
}

/**
 * Format-aware body validation. `validateBody` below is the POSITIONAL
 * special case kept for callers that predate named parameters.
 */
export function validateBodyText(
  bodyText: string,
  format: TemplateParameterFormat = 'POSITIONAL',
): string[] {
  if (!bodyText.trim()) throw new Error('Body text is required.');
  if (bodyText.length > TEMPLATE_LIMITS.bodyMaxLength) {
    throw new Error(
      `Body text exceeds ${TEMPLATE_LIMITS.bodyMaxLength} chars (got ${bodyText.length}).`,
    );
  }
  const tokens = validateTextVariables(bodyText, format, 'Body');
  assertNoEdgeVariables(bodyText);
  return tokens;
}

export function validateBody(bodyText: string): number[] {
  return validateBodyText(bodyText, 'POSITIONAL').map(Number);
}

export function validateFooter(footerText: string | undefined): void {
  if (!footerText) return;
  if (footerText.length > TEMPLATE_LIMITS.footerMaxLength) {
    throw new Error(
      `Footer text exceeds ${TEMPLATE_LIMITS.footerMaxLength} chars (got ${footerText.length}).`,
    );
  }
  // Footers take no parameters in either scheme.
  if (
    extractVariableIndices(footerText).length > 0 ||
    extractNamedVariables(footerText).length > 0
  ) {
    throw new Error('Footer text cannot contain variables (Meta rule).');
  }
}

export interface HeaderValidationResult {
  variableCount: number;
  /** Placeholder tokens in order — `['1']` or `['first_name']`. */
  variableNames: string[];
}

function assertSampleMediaUrl(url: string, field = 'header_media_url'): void {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error(`${field} must use http(s) scheme.`);
    }
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
}

export function validateHeader(
  payload: Pick<
    TemplatePayload,
    'header_type' | 'header_content' | 'header_media_url' | 'header_handle'
  >,
  format: TemplateParameterFormat = 'POSITIONAL',
): HeaderValidationResult {
  const { header_type, header_content, header_media_url, header_handle } =
    payload;
  const none: HeaderValidationResult = { variableCount: 0, variableNames: [] };
  if (!header_type) return none;

  // LOCATION headers are declared bare — no text, no media, no example.
  // Meta collects latitude/longitude/name/address at send time instead,
  // so there is nothing here to validate.
  if (header_type === 'location') return none;

  if (header_type === 'text') {
    if (!header_content || !header_content.trim()) {
      throw new Error('Text header requires header_content.');
    }
    if (header_content.length > TEMPLATE_LIMITS.headerTextMaxLength) {
      throw new Error(
        `Header text exceeds ${TEMPLATE_LIMITS.headerTextMaxLength} chars (got ${header_content.length}).`,
      );
    }
    // A text header's positional numbering is independent of the body's:
    // it starts over at {{1}}.
    const tokens = validateSingleVariableText(
      header_content,
      format,
      'Text header',
    );
    return { variableCount: tokens.length, variableNames: tokens };
  }

  if (!header_media_url && !header_handle) {
    throw new Error(
      `${header_type} header requires either a public sample URL (header_media_url) or a Resumable Upload handle (header_handle).`,
    );
  }
  if (header_media_url) assertSampleMediaUrl(header_media_url);
  return none;
}

function countButtonsByType(
  buttons: TemplateButton[],
): Record<TemplateButton['type'], number> {
  const counts: Record<TemplateButton['type'], number> = {
    QUICK_REPLY: 0,
    URL: 0,
    PHONE_NUMBER: 0,
    COPY_CODE: 0,
  };
  for (const b of buttons) counts[b.type]++;
  return counts;
}

export function validateButtons(
  buttons: TemplateButton[] | undefined,
  format: TemplateParameterFormat = 'POSITIONAL',
): void {
  if (!buttons || buttons.length === 0) return;
  if (buttons.length > TEMPLATE_LIMITS.maxButtonsTotal) {
    throw new Error(
      `Templates can have at most ${TEMPLATE_LIMITS.maxButtonsTotal} buttons (got ${buttons.length}).`,
    );
  }

  const counts = countButtonsByType(buttons);
  if (counts.URL > TEMPLATE_LIMITS.maxUrlButtons) {
    throw new Error(
      `At most ${TEMPLATE_LIMITS.maxUrlButtons} URL buttons allowed (got ${counts.URL}).`,
    );
  }
  if (counts.PHONE_NUMBER > TEMPLATE_LIMITS.maxPhoneButtons) {
    throw new Error(
      `At most ${TEMPLATE_LIMITS.maxPhoneButtons} PHONE_NUMBER button allowed (got ${counts.PHONE_NUMBER}).`,
    );
  }
  if (counts.COPY_CODE > TEMPLATE_LIMITS.maxCopyCodeButtons) {
    throw new Error(
      `At most ${TEMPLATE_LIMITS.maxCopyCodeButtons} COPY_CODE button allowed (got ${counts.COPY_CODE}).`,
    );
  }

  let sawNonQR = false;
  for (const b of buttons) {
    if (b.type === 'QUICK_REPLY') {
      if (sawNonQR) {
        throw new Error(
          'QUICK_REPLY buttons cannot be interleaved with URL / PHONE_NUMBER / COPY_CODE buttons — group them at the start.',
        );
      }
    } else {
      sawNonQR = true;
    }
  }

  for (let i = 0; i < buttons.length; i++) {
    validateButtonFields(buttons[i], i, format);
  }
}

/**
 * Per-button field checks, shared by the template's own buttons and by
 * carousel card buttons. `where` prefixes the error so a card button
 * says "Card #2 button #1" rather than a bare index the user can't
 * locate in the form.
 */
export function validateButtonFields(
  b: TemplateButton,
  index: number,
  format: TemplateParameterFormat = 'POSITIONAL',
  where = 'Button',
): void {
  const label = `${where} #${index + 1}`;
  if (!b.text?.trim()) {
    throw new Error(`${label} (${b.type}) is missing text.`);
  }
  if (b.text.length > TEMPLATE_LIMITS.buttonTextMaxLength) {
    throw new Error(
      `${label} text exceeds ${TEMPLATE_LIMITS.buttonTextMaxLength} chars.`,
    );
  }
  switch (b.type) {
    case 'URL': {
      if (!b.url?.trim()) {
        throw new Error(`${label} (URL) is missing url.`);
      }
      try {
        new URL(b.url);
      } catch {
        throw new Error(`${label} (URL) has an invalid url.`);
      }
      const urlVars = validateSingleVariableText(
        b.url,
        format,
        `${label} (URL)`,
      );
      if (urlVars.length === 1 && !b.example?.trim()) {
        throw new Error(
          `${label} (URL) uses {{${urlVars[0]}}} — Meta requires an example value.`,
        );
      }
      break;
    }
    case 'PHONE_NUMBER':
      if (!b.phone_number?.trim()) {
        throw new Error(`${label} (PHONE_NUMBER) is missing phone_number.`);
      }
      break;
    case 'COPY_CODE':
      if (!b.example?.trim()) {
        throw new Error(`${label} (COPY_CODE) is missing example value.`);
      }
      break;
  }
}

export function validateSampleValues(
  payload: TemplatePayload,
  bodyVarCount: number,
  headerVarCount: number,
): void {
  const samples = payload.sample_values ?? {};
  const body = samples.body ?? [];
  const header = samples.header ?? [];

  if (body.length !== bodyVarCount) {
    throw new Error(
      `Body has ${bodyVarCount} variable(s) — supply exactly ${bodyVarCount} sample value(s) (got ${body.length}).`,
    );
  }
  if (header.length !== headerVarCount) {
    throw new Error(
      `Header has ${headerVarCount} variable(s) — supply exactly ${headerVarCount} sample value(s) (got ${header.length}).`,
    );
  }
  for (let i = 0; i < body.length; i++) {
    if (!body[i] || !body[i].trim()) {
      throw new Error(`Body sample value #${i + 1} is empty.`);
    }
  }
  for (let i = 0; i < header.length; i++) {
    if (!header[i] || !header[i].trim()) {
      throw new Error(`Header sample value #${i + 1} is empty.`);
    }
  }
}

export function isCarouselTemplate(
  payload: Pick<TemplatePayload, 'cards'>,
): boolean {
  return (payload.cards?.length ?? 0) > 0;
}

/**
 * CAROUSEL rules, which are stricter than they first look:
 *
 *   - The outer bubble is body-only. No header, no footer, no buttons —
 *     those live on the cards.
 *   - 1-10 cards, each with a media header, a body, and 1-2 buttons.
 *   - Every card must have the SAME header format and the SAME button
 *     types in the same order. Meta renders one swipeable strip, so a
 *     card that differs in shape breaks the whole template rather than
 *     just itself.
 *
 * Card #1 is treated as the reference shape and later cards are diffed
 * against it, because that is the order the user built them in and so
 * the one they will read the error against.
 */
export function validateCarousel(
  payload: Pick<
    TemplatePayload,
    'cards' | 'header_type' | 'footer_text' | 'buttons'
  >,
  format: TemplateParameterFormat = 'POSITIONAL',
): void {
  const cards = payload.cards ?? [];
  if (cards.length === 0) return;

  if (cards.length > TEMPLATE_LIMITS.maxCarouselCards) {
    throw new Error(
      `A carousel takes at most ${TEMPLATE_LIMITS.maxCarouselCards} cards (got ${cards.length}).`,
    );
  }
  if (payload.header_type) {
    throw new Error(
      'Carousel templates cannot have a header on the outer message — the media belongs on each card (Meta rule).',
    );
  }
  if (payload.footer_text?.trim()) {
    throw new Error('Carousel templates cannot have a footer (Meta rule).');
  }
  if (payload.buttons && payload.buttons.length > 0) {
    throw new Error(
      'Carousel templates cannot have buttons on the outer message — put them on each card (Meta rule).',
    );
  }

  const reference = cards[0];
  cards.forEach((card, i) => {
    const label = `Card #${i + 1}`;

    if (card.header_format !== 'image' && card.header_format !== 'video') {
      throw new Error(
        `${label} needs an image or video header (Meta rule — carousel cards cannot use text, document, or location headers).`,
      );
    }
    if (card.header_format !== reference.header_format) {
      throw new Error(
        `${label} uses a ${card.header_format} header but card #1 uses ${reference.header_format} — every card in a carousel must use the same header format (Meta rule).`,
      );
    }
    if (!card.header_handle && !card.header_media_url) {
      throw new Error(
        `${label} requires either a public sample URL or a Resumable Upload handle for its ${card.header_format} header.`,
      );
    }
    if (card.header_media_url) {
      assertSampleMediaUrl(card.header_media_url, `${label} header_media_url`);
    }

    if (!card.body_text?.trim()) {
      throw new Error(`${label} is missing body text.`);
    }
    if (card.body_text.length > TEMPLATE_LIMITS.cardBodyMaxLength) {
      throw new Error(
        `${label} body exceeds ${TEMPLATE_LIMITS.cardBodyMaxLength} chars (got ${card.body_text.length}).`,
      );
    }
    const cardVars = validateTextVariables(
      card.body_text,
      format,
      `${label} body`,
    );
    // Card bodies are bodies: same leading/trailing-variable ban. Applied
    // here rather than assumed exempt, because a rejected carousel costs
    // the user a full 24-hour review cycle to discover.
    try {
      assertNoEdgeVariables(card.body_text);
    } catch (e) {
      throw new Error(
        `${label}: ${e instanceof Error ? e.message : 'invalid body'}`,
      );
    }
    const samples = card.body_samples ?? [];
    if (samples.length !== cardVars.length) {
      throw new Error(
        `${label} body has ${cardVars.length} variable(s) — supply exactly ${cardVars.length} sample value(s) (got ${samples.length}).`,
      );
    }
    samples.forEach((s, si) => {
      if (!s?.trim()) {
        throw new Error(`${label} sample value #${si + 1} is empty.`);
      }
    });

    const buttons = card.buttons ?? [];
    if (buttons.length === 0) {
      throw new Error(`${label} needs at least one button (Meta rule).`);
    }
    if (buttons.length > TEMPLATE_LIMITS.maxCardButtons) {
      throw new Error(
        `${label} has ${buttons.length} buttons — a carousel card takes at most ${TEMPLATE_LIMITS.maxCardButtons} (Meta rule).`,
      );
    }
    if (buttons.length !== (reference.buttons?.length ?? 0)) {
      throw new Error(
        `${label} has ${buttons.length} button(s) but card #1 has ${reference.buttons?.length ?? 0} — every card in a carousel must have the same buttons (Meta rule).`,
      );
    }
    buttons.forEach((b, bi) => {
      if (b.type === 'COPY_CODE') {
        throw new Error(
          `${label} button #${bi + 1} is a copy-code button — carousel cards support quick reply, URL, and phone-number buttons only (Meta rule).`,
        );
      }
      const referenceType = reference.buttons?.[bi]?.type;
      if (b.type !== referenceType) {
        throw new Error(
          `${label} button #${bi + 1} is ${b.type} but card #1's is ${referenceType} — every card in a carousel must use the same button types in the same order (Meta rule).`,
        );
      }
      validateButtonFields(b, bi, format, `${label} button`);
    });
  });
}

export function validateTemplatePayload(payload: TemplatePayload): {
  bodyVarCount: number;
  headerVarCount: number;
  parameterFormat: TemplateParameterFormat;
  bodyVariableNames: string[];
  headerVariableNames: string[];
} {
  const format = resolveParameterFormat(payload.parameter_format);
  validateTemplateName(payload.name);
  if (!payload.language?.trim()) {
    throw new Error('Language is required.');
  }
  const bodyVars = validateBodyText(payload.body_text, format);

  // A carousel owns its header/footer/button rules — running the
  // single-bubble validators first would report "image header requires a
  // sample URL" for a stray header that a carousel cannot have at all.
  let headerResult: HeaderValidationResult = {
    variableCount: 0,
    variableNames: [],
  };
  if (isCarouselTemplate(payload)) {
    validateCarousel(payload, format);
  } else {
    validateFooter(payload.footer_text);
    headerResult = validateHeader(payload, format);
    validateButtons(payload.buttons, format);
  }
  validateSampleValues(payload, bodyVars.length, headerResult.variableCount);
  return {
    bodyVarCount: bodyVars.length,
    headerVarCount: headerResult.variableCount,
    parameterFormat: format,
    bodyVariableNames: bodyVars,
    headerVariableNames: headerResult.variableNames,
  };
}
