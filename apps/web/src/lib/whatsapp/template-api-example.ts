/**
 * Build a copy-pasteable send example for one template: the exact
 * `POST /api/v1/messages` body that triggers it, plus a curl wrapper.
 *
 * The point is that the *shape of the parameters is not obvious from the
 * template*. A plain text template takes a flat array; the moment it has
 * a media header, a location pin, a URL-suffix button, named variables or
 * carousel cards, the caller has to send a structured object with exactly
 * the right keys. That mapping already exists in `buildSendComponents`,
 * but a user integrating against the public API can't see it — so we
 * generate the example from the template row itself.
 *
 * Sample values from the template's own `sample_values` are used as the
 * placeholder data, so the example is immediately runnable rather than
 * full of "string".
 */

import type { MessageTemplate, TemplateButton } from '@/types';
import { extractNamedVariables, extractVariableIndices } from './template-validators';

const PLACEHOLDER_PHONE = '+14155550123';

export interface TemplateApiExample {
  /** Structured request body. */
  body: Record<string, unknown>;
  /** Ready-to-run curl for the same request. */
  curl: string;
  /** Notes about values the caller must replace. */
  notes: string[];
}

function tokensFor(text: string, named: boolean): string[] {
  return named ? extractNamedVariables(text) : extractVariableIndices(text).map(String);
}

/** Sample for the nth variable, falling back to something obvious. */
function sampleAt(samples: string[] | undefined, i: number, token: string): string {
  const value = samples?.[i];
  return value && value.trim() ? value : `<${token}>`;
}

function buttonParamsFor(
  buttons: TemplateButton[] | undefined,
  named: boolean,
): { params: Record<number, string>; notes: string[] } {
  const params: Record<number, string> = {};
  const notes: string[] = [];
  (buttons ?? []).forEach((b, i) => {
    if (b.type === 'URL') {
      const token = tokensFor(b.url, named)[0];
      if (token) {
        params[i] = b.example?.trim() || `<${token}>`;
        notes.push(
          `buttonParams[${i}] fills the {{${token}}} suffix on the "${b.text}" URL button.`,
        );
      }
    } else if (b.type === 'COPY_CODE') {
      params[i] = b.example?.trim() || '<code>';
      notes.push(
        `buttonParams[${i}] is the code the "${b.text}" copy button copies.`,
      );
    }
  });
  return { params, notes };
}

export function buildTemplateApiExample(
  template: MessageTemplate,
  baseUrl = 'https://your-domain.com',
): TemplateApiExample {
  const named = template.parameter_format === 'NAMED';
  const notes: string[] = [];

  const bodyTokens = tokensFor(template.body_text, named);
  const bodySamples = template.sample_values?.body;
  const bodyValues = bodyTokens.map((t, i) => sampleAt(bodySamples, i, t));

  // Anything beyond flat body variables forces the structured form.
  const cards = template.cards ?? [];
  const isCarousel = cards.length > 0;
  const headerType = template.header_type;
  const headerTokens =
    headerType === 'text' ? tokensFor(template.header_content ?? '', named) : [];
  const { params: buttonParams, notes: buttonNotes } = buttonParamsFor(
    template.buttons,
    named,
  );

  const needsStructured =
    named ||
    isCarousel ||
    headerTokens.length > 0 ||
    headerType === 'image' ||
    headerType === 'video' ||
    headerType === 'document' ||
    headerType === 'location' ||
    Object.keys(buttonParams).length > 0;

  let params: unknown;

  if (!needsStructured) {
    // Simplest case: `params` is a positional array of body values.
    params = bodyValues;
    if (bodyValues.length === 0) {
      notes.push('This template takes no variables — omit `params` entirely.');
    }
  } else {
    const structured: Record<string, unknown> = {};

    if (named) {
      structured.bodyNamed = Object.fromEntries(
        bodyTokens.map((t, i) => [t, sampleAt(bodySamples, i, t)]),
      );
      notes.push(
        'This template uses named variables, so values are keyed by name (order does not matter).',
      );
    } else if (bodyValues.length > 0) {
      structured.body = bodyValues;
    }

    if (headerTokens.length > 0) {
      structured.headerText = sampleAt(
        template.sample_values?.header,
        0,
        headerTokens[0],
      );
    }

    if (headerType === 'image' || headerType === 'video' || headerType === 'document') {
      structured.headerMediaUrl =
        template.header_media_url || `https://your-cdn.com/file`;
      notes.push(
        `Meta requires the ${headerType} on every send. Pass headerMediaUrl (a public link) or headerMediaId (a Meta media id).`,
      );
    }

    if (headerType === 'location') {
      structured.headerLocation = {
        latitude: '12.9716',
        longitude: '77.5946',
        name: 'Warehouse',
        address: '100 Example Road',
      };
      notes.push(
        'The location pin is per message — latitude and longitude are required on every send.',
      );
    }

    if (Object.keys(buttonParams).length > 0) {
      structured.buttonParams = buttonParams;
      notes.push(...buttonNotes);
    }

    if (isCarousel) {
      structured.cards = cards.map((card) => {
        const tokens = tokensFor(card.body_text, named);
        const entry: Record<string, unknown> = {
          headerMediaUrl: card.header_media_url || 'https://your-cdn.com/card.jpg',
        };
        if (tokens.length > 0) {
          const values = tokens.map((t, i) => sampleAt(card.body_samples, i, t));
          if (named) {
            entry.bodyNamed = Object.fromEntries(
              tokens.map((t, i) => [t, values[i]]),
            );
          } else {
            entry.body = values;
          }
        }
        const cardButtons = buttonParamsFor(card.buttons, named);
        if (Object.keys(cardButtons.params).length > 0) {
          entry.buttonParams = cardButtons.params;
        }
        return entry;
      });
      notes.push(
        `cards is positional — one entry per carousel card (${cards.length} here), each carrying its own media and values.`,
      );
    }

    params = structured;
  }

  const body: Record<string, unknown> = {
    to: PLACEHOLDER_PHONE,
    type: 'template',
    template: {
      name: template.name,
      language: template.language || 'en_US',
      ...(Array.isArray(params) && params.length === 0 ? {} : { params }),
    },
  };

  const json = JSON.stringify(body, null, 2);
  const curl = [
    `curl -X POST '${baseUrl.replace(/\/$/, '')}/api/v1/messages' \\`,
    `  -H 'Authorization: Bearer <YOUR_API_KEY>' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${json.replace(/'/g, "'\\''")}'`,
  ].join('\n');

  notes.unshift(
    'Replace <YOUR_API_KEY> with a key that has the messages:send scope, and `to` with the recipient in E.164 format.',
  );

  if (template.status !== 'APPROVED') {
    notes.push(
      `This template is ${template.status ?? 'DRAFT'} — Meta only delivers APPROVED templates.`,
    );
  }

  return { body, curl, notes };
}
