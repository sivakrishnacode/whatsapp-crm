import { describe, it, expect } from 'vitest';
import {
  extractNamedVariables,
  validateCarousel,
  validateHeader,
  validateTemplatePayload,
  type TemplatePayload,
} from './template-validators.util';
import { buildMetaTemplatePayload } from './template-components.util';
import {
  buildSendComponents,
  renderTemplateBody,
} from './template-send-builder.util';
import { parseCarouselCards, parseHeaderType } from './template-sync.util';
import type { MessageTemplate, TemplateCard } from '../types/index';

const base: TemplatePayload = {
  name: 'promo',
  category: 'Marketing',
  language: 'en_US',
  body_text: 'Hello there',
};

function card(overrides: Partial<TemplateCard> = {}): TemplateCard {
  return {
    header_format: 'image',
    header_media_url: 'https://cdn.example.com/a.jpg',
    body_text: 'Card copy',
    body_samples: [],
    buttons: [{ type: 'QUICK_REPLY', text: 'Shop' }],
    ...overrides,
  };
}

describe('LOCATION headers', () => {
  it('needs no media or content', () => {
    expect(() => validateHeader({ header_type: 'location' })).not.toThrow();
    expect(validateHeader({ header_type: 'location' })).toEqual({
      variableCount: 0,
      variableNames: [],
    });
  });

  it('submits as a bare component with no example', () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      header_type: 'location',
    });
    expect(payload.components[0]).toEqual({
      type: 'HEADER',
      format: 'LOCATION',
    });
  });

  it('requires a pin at send time', () => {
    const template = {
      ...base,
      header_type: 'location',
    } as unknown as MessageTemplate;
    expect(() => buildSendComponents(template)).toThrow(
      /latitude and longitude/,
    );
    expect(
      buildSendComponents(template, {
        headerLocation: { latitude: '12.9', longitude: '77.5', name: 'HQ' },
      })[0],
    ).toEqual({
      type: 'header',
      parameters: [
        {
          type: 'location',
          location: { latitude: '12.9', longitude: '77.5', name: 'HQ' },
        },
      ],
    });
  });

  it('round-trips through sync', () => {
    expect(parseHeaderType({ type: 'HEADER', format: 'LOCATION' })).toBe(
      'location',
    );
  });
});

describe('NAMED parameters', () => {
  const named: TemplatePayload = {
    ...base,
    parameter_format: 'NAMED',
    body_text: 'Hi {{customer_name}}, order {{order_id}} shipped.',
    sample_values: { body: ['Mark', 'A-1042'] },
  };

  it('reads names in order of first appearance, deduplicated', () => {
    expect(extractNamedVariables('{{b}} {{a}} {{b}}')).toEqual(['b', 'a']);
  });

  it('accepts a valid named payload', () => {
    expect(validateTemplatePayload(named)).toMatchObject({
      parameterFormat: 'NAMED',
      bodyVarCount: 2,
      bodyVariableNames: ['customer_name', 'order_id'],
    });
  });

  it('rejects a mix of named and positional', () => {
    expect(() =>
      validateTemplatePayload({
        ...named,
        body_text: 'Hi {{customer_name}}, order {{1}}',
        sample_values: { body: ['Mark'] },
      }),
    ).toThrow(/positional variable \{\{1\}\}/);
    expect(() =>
      validateTemplatePayload({
        ...base,
        body_text: 'Hi {{customer_name}}',
        sample_values: { body: ['Mark'] },
      }),
    ).toThrow(/named variable \{\{customer_name\}\}/);
  });

  it('rejects an invalid parameter name', () => {
    expect(() =>
      validateTemplatePayload({
        ...named,
        body_text: 'Hi {{Customer Name}}',
        sample_values: { body: ['Mark'] },
      }),
    ).toThrow(/not a valid named parameter/);
  });

  it('submits named examples and declares the format', () => {
    const payload = buildMetaTemplatePayload(named);
    expect(payload.parameter_format).toBe('NAMED');
    expect(payload.components[0]).toEqual({
      type: 'BODY',
      text: named.body_text,
      example: {
        body_text_named_params: [
          { param_name: 'customer_name', example: 'Mark' },
          { param_name: 'order_id', example: 'A-1042' },
        ],
      },
    });
  });

  it('omits parameter_format for positional templates', () => {
    expect(buildMetaTemplatePayload(base).parameter_format).toBeUndefined();
  });

  it('sends values by name, from either the map or the ordered array', () => {
    const template = named as unknown as MessageTemplate;
    const expected = [
      { type: 'text', parameter_name: 'customer_name', text: 'Mark' },
      { type: 'text', parameter_name: 'order_id', text: 'A-1042' },
    ];
    expect(
      buildSendComponents(template, { body: ['Mark', 'A-1042'] })[0],
    ).toEqual({ type: 'body', parameters: expected });
    expect(
      buildSendComponents(template, {
        bodyNamed: { order_id: 'A-1042', customer_name: 'Mark' },
      })[0],
    ).toEqual({ type: 'body', parameters: expected });
  });

  it('renders a named body for the stored message text', () => {
    expect(
      renderTemplateBody('Hi {{customer_name}}, ref {{order_id}}', {
        bodyNamed: { customer_name: 'Mark' },
      }),
    ).toBe('Hi Mark, ref {{order_id}}');
  });
});

describe('CAROUSEL templates', () => {
  const carousel: TemplatePayload = {
    ...base,
    cards: [
      card(),
      card({ header_media_url: 'https://cdn.example.com/b.jpg' }),
    ],
  };

  it('accepts a uniform carousel', () => {
    expect(() => validateTemplatePayload(carousel)).not.toThrow();
  });

  it('rejects an outer header, footer, or buttons', () => {
    expect(() =>
      validateCarousel({ ...carousel, header_type: 'image' }),
    ).toThrow(/cannot have a header/);
    expect(() => validateCarousel({ ...carousel, footer_text: 'x' })).toThrow(
      /cannot have a footer/,
    );
    expect(() =>
      validateCarousel({
        ...carousel,
        buttons: [{ type: 'QUICK_REPLY', text: 'x' }],
      }),
    ).toThrow(/cannot have buttons/);
  });

  it('rejects cards that differ in shape', () => {
    expect(() =>
      validateCarousel({ cards: [card(), card({ header_format: 'video' })] }),
    ).toThrow(/same header format/);
    expect(() =>
      validateCarousel({
        cards: [
          card(),
          card({
            buttons: [
              { type: 'QUICK_REPLY', text: 'a' },
              { type: 'QUICK_REPLY', text: 'b' },
            ],
          }),
        ],
      }),
    ).toThrow(/same buttons/);
    expect(() =>
      validateCarousel({
        cards: [
          card(),
          card({
            buttons: [{ type: 'URL', text: 'go', url: 'https://example.com' }],
          }),
        ],
      }),
    ).toThrow(/same button types/);
  });

  it('enforces per-card limits', () => {
    expect(() =>
      validateCarousel({ cards: Array.from({ length: 11 }, () => card()) }),
    ).toThrow(/at most 10 cards/);
    expect(() =>
      validateCarousel({ cards: [card({ body_text: 'x'.repeat(161) })] }),
    ).toThrow(/exceeds 160 chars/);
    expect(() => validateCarousel({ cards: [card({ buttons: [] })] })).toThrow(
      /at least one button/,
    );
    expect(() =>
      validateCarousel({
        cards: [
          card({ buttons: [{ type: 'COPY_CODE', text: 'c', example: 'X' }] }),
        ],
      }),
    ).toThrow(/copy-code/);
    expect(() =>
      validateCarousel({
        cards: [
          card({ header_media_url: undefined, header_handle: undefined }),
        ],
      }),
    ).toThrow(/Resumable Upload handle/);
  });

  it('requires a sample for every card variable', () => {
    expect(() =>
      validateCarousel({ cards: [card({ body_text: 'Save {{1}} today' })] }),
    ).toThrow(/exactly 1 sample/);
  });

  it('applies the leading/trailing-variable ban to card bodies too', () => {
    expect(() =>
      validateCarousel({
        cards: [card({ body_text: 'Now {{1}}', body_samples: ['20% off'] })],
      }),
    ).toThrow(/Card #1.*can't end with a variable/);
  });

  it('builds BODY + CAROUSEL with per-card components', () => {
    // Media samples must be Resumable-Upload handles: the live API
    // rejects example.header_url with "Missing sample parameter for title
    // type", so the builder only ever emits header_handle.
    const withHandles = {
      ...carousel,
      cards: carousel.cards!.map((c, i) => ({
        ...c,
        header_handle: `4::h${i}`,
      })),
    };
    const payload = buildMetaTemplatePayload(withHandles);
    expect(payload.components.map((c) => c.type)).toEqual(['BODY', 'CAROUSEL']);
    expect(payload.components[1].cards?.[0].components).toEqual([
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: ['4::h0'] },
      },
      { type: 'BODY', text: 'Card copy' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop' }] },
    ]);
  });

  it('refuses to build a media header with no uploaded handle', () => {
    // Guards against sending a payload Meta will reject: reaching this
    // means resolveTemplateMediaHandles was skipped.
    expect(() => buildMetaTemplatePayload(carousel)).toThrow(
      /no uploaded Meta handle/,
    );
    expect(() =>
      buildMetaTemplatePayload({
        ...base,
        header_type: 'image',
        header_media_url: 'https://cdn.example.com/a.jpg',
      }),
    ).toThrow(/no uploaded Meta handle/);
  });

  it('sends card media with an index, falling back to the stored URL', () => {
    const template = carousel as unknown as MessageTemplate;
    const components = buildSendComponents(template);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ type: 'carousel' });
    const cards = (components[0] as { cards: unknown[] }).cards;
    expect(cards[0]).toEqual({
      card_index: 0,
      components: [
        {
          type: 'header',
          parameters: [
            { type: 'image', image: { link: 'https://cdn.example.com/a.jpg' } },
          ],
        },
      ],
    });
    expect(cards[1]).toMatchObject({ card_index: 1 });
  });

  it('parses Meta carousel components back into cards', () => {
    expect(
      parseCarouselCards({
        type: 'CAROUSEL',
        cards: [
          {
            components: [
              {
                type: 'HEADER',
                format: 'IMAGE',
                example: { header_handle: ['4::aW'] },
              },
              {
                type: 'BODY',
                text: 'Save {{1}}',
                example: { body_text: [['20%']] },
              },
              {
                type: 'BUTTONS',
                buttons: [{ type: 'QUICK_REPLY', text: 'Shop' }],
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        header_format: 'image',
        header_handle: '4::aW',
        header_media_url: null,
        body_text: 'Save {{1}}',
        body_samples: ['20%'],
        buttons: [{ type: 'QUICK_REPLY', text: 'Shop' }],
      },
    ]);
  });
});
