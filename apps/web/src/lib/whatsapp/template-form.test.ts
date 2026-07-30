import { describe, it, expect } from 'vitest';
import {
  buildTemplateSubmitPayload,
  emptyTemplateForm,
  formFromTemplate,
  nextVariableToken,
  resizeSamples,
  templateTypeFromRow,
  templateTypeToHeader,
  variableTokens,
  type TemplateFormData,
} from './template-form';
import type { MessageTemplate } from '@/types';

const form = (overrides: Partial<TemplateFormData> = {}): TemplateFormData => ({
  ...emptyTemplateForm,
  name: 'order_update',
  body_text: 'Hello there',
  ...overrides,
});

describe('template type ↔ header format', () => {
  it('maps FILE to Meta DOCUMENT and back', () => {
    expect(templateTypeToHeader('FILE')).toBe('document');
    expect(templateTypeFromRow({ header_type: 'document' })).toBe('FILE');
  });

  it('maps LOCATION through unchanged', () => {
    expect(templateTypeToHeader('LOCATION')).toBe('location');
    expect(templateTypeFromRow({ header_type: 'location' })).toBe('LOCATION');
  });

  it('treats a carousel as a type, not a header', () => {
    expect(templateTypeToHeader('CAROUSEL')).toBeUndefined();
    expect(
      templateTypeFromRow({
        header_type: undefined,
        cards: [
          {
            header_format: 'image',
            body_text: 'x',
            buttons: [],
          },
        ],
      }),
    ).toBe('CAROUSEL');
  });

  it('falls back to NONE for an unset header', () => {
    expect(templateTypeFromRow({})).toBe('NONE');
  });
});

describe('variableTokens / nextVariableToken', () => {
  it('returns positional indices as tokens', () => {
    expect(variableTokens('Hi {{1}} and {{2}}', 'POSITIONAL')).toEqual([
      '1',
      '2',
    ]);
  });

  it('returns named variables in order of first appearance', () => {
    expect(variableTokens('Hi {{name}}, ref {{ref}} {{name}}', 'NAMED')).toEqual(
      ['name', 'ref'],
    );
  });

  it('continues past the highest index, not the count', () => {
    // Text with a gap would otherwise produce a duplicate {{3}}.
    expect(nextVariableToken('Hi {{1}} {{3}}', 'POSITIONAL')).toBe('4');
    expect(nextVariableToken('', 'POSITIONAL')).toBe('1');
  });

  it('generates unused placeholder names', () => {
    expect(nextVariableToken('', 'NAMED')).toBe('variable_1');
    expect(nextVariableToken('{{variable_1}}', 'NAMED')).toBe('variable_2');
  });
});

describe('resizeSamples', () => {
  it('pads and truncates to the placeholder count', () => {
    expect(resizeSamples(['a'], 3)).toEqual(['a', '', '']);
    expect(resizeSamples(['a', 'b', 'c'], 1)).toEqual(['a']);
  });

  it('returns the same array when the length already matches', () => {
    const same = ['a'];
    expect(resizeSamples(same, 1)).toBe(same);
  });
});

describe('buildTemplateSubmitPayload', () => {
  it('emits only the media URL for media types', () => {
    const payload = buildTemplateSubmitPayload(
      form({
        template_type: 'IMAGE',
        header_media_url: ' https://cdn.example.com/a.jpg ',
        header_content: 'left over from a TEXT header',
      }),
    );
    expect(payload.header_type).toBe('image');
    expect(payload.header_media_url).toBe('https://cdn.example.com/a.jpg');
    // Switching type in the UI keeps old inputs in state; they must not
    // reach Meta.
    expect(payload.header_content).toBeUndefined();
  });

  it('emits a location header with no content or media', () => {
    const payload = buildTemplateSubmitPayload(
      form({
        template_type: 'LOCATION',
        header_media_url: 'https://cdn.example.com/a.jpg',
      }),
    );
    expect(payload.header_type).toBe('location');
    expect(payload.header_media_url).toBeUndefined();
    expect(payload.header_content).toBeUndefined();
  });

  it('drops the outer header, footer, and buttons for a carousel', () => {
    const payload = buildTemplateSubmitPayload(
      form({
        template_type: 'CAROUSEL',
        footer_text: 'Terms apply',
        buttons: [{ type: 'QUICK_REPLY', text: 'Stop' }],
        cards: [
          {
            header_format: 'image',
            header_media_url: 'https://cdn.example.com/a.jpg',
            header_media_file: null,
            body_text: ' Save {{1}} ',
            body_samples: [' 20% '],
            buttons: [{ type: 'QUICK_REPLY', text: 'Shop' }],
          },
        ],
      }),
    );
    expect(payload.header_type).toBeUndefined();
    expect(payload.footer_text).toBeUndefined();
    expect(payload.buttons).toBeUndefined();
    expect(payload.cards).toEqual([
      {
        header_format: 'image',
        header_media_url: 'https://cdn.example.com/a.jpg',
        body_text: 'Save {{1}}',
        body_samples: ['20%'],
        buttons: [{ type: 'QUICK_REPLY', text: 'Shop' }],
      },
    ]);
  });

  it('carries the parameter format and omits empty samples', () => {
    const positional = buildTemplateSubmitPayload(form());
    expect(positional.parameter_format).toBe('POSITIONAL');
    expect(positional.sample_values).toBeUndefined();

    const named = buildTemplateSubmitPayload(
      form({
        parameter_format: 'NAMED',
        body_text: 'Hi {{customer_name}}',
        body_samples: ['Mark'],
      }),
    );
    expect(named.parameter_format).toBe('NAMED');
    expect(named.sample_values).toEqual({ body: ['Mark'] });
  });

  it('includes a text header sample only for TEXT headers', () => {
    expect(
      buildTemplateSubmitPayload(
        form({
          template_type: 'TEXT',
          header_content: 'Your {{1}} order',
          header_sample: 'summer',
        }),
      ).sample_values,
    ).toEqual({ header: ['summer'] });

    expect(
      buildTemplateSubmitPayload(
        form({ template_type: 'NONE', header_sample: 'summer' }),
      ).sample_values,
    ).toBeUndefined();
  });
});

describe('formFromTemplate', () => {
  it('restores a carousel row into editable form state', () => {
    const row = {
      id: 'row-1',
      user_id: 'u1',
      name: 'promo',
      category: 'Marketing',
      language: 'en_US',
      parameter_format: 'NAMED',
      body_text: 'Hi {{customer_name}}',
      sample_values: { body: ['Mark'] },
      cards: [
        {
          header_format: 'video',
          header_media_url: 'https://cdn.example.com/a.mp4',
          body_text: 'Card',
          body_samples: [],
          buttons: [{ type: 'QUICK_REPLY', text: 'Shop' }],
        },
      ],
      created_at: '2026-01-01T00:00:00Z',
    } as unknown as MessageTemplate;

    expect(formFromTemplate(row)).toMatchObject({
      template_type: 'CAROUSEL',
      parameter_format: 'NAMED',
      body_samples: ['Mark'],
      cards: [
        {
          header_format: 'video',
          header_media_url: 'https://cdn.example.com/a.mp4',
          body_text: 'Card',
          buttons: [{ type: 'QUICK_REPLY', text: 'Shop' }],
        },
      ],
    });
  });

  it('defaults a legacy row with no parameter_format to positional', () => {
    const row = {
      name: 'legacy',
      category: 'Utility',
      body_text: 'Hi {{1}}',
    } as unknown as MessageTemplate;
    expect(formFromTemplate(row).parameter_format).toBe('POSITIONAL');
  });
});
