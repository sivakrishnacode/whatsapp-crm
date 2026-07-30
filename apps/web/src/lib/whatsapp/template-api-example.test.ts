import { describe, it, expect } from 'vitest';
import { buildTemplateApiExample } from './template-api-example';
import { TEMPLATE_LIBRARY } from './template-library';
import { buildTemplateSubmitPayload } from './template-form';
import type { MessageTemplate } from '@/types';

function tpl(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 'row-1',
    user_id: 'u1',
    name: 'order_update',
    category: 'Utility',
    language: 'en_US',
    body_text: 'Hi there, your order is confirmed.',
    status: 'APPROVED',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as MessageTemplate;
}

function templateOf(body: Record<string, unknown>) {
  return body.template as Record<string, unknown>;
}

describe('buildTemplateApiExample', () => {
  it('omits params entirely for a template with no variables', () => {
    const { body, notes } = buildTemplateApiExample(tpl());
    expect(templateOf(body)).toEqual({ name: 'order_update', language: 'en_US' });
    expect(notes.join(' ')).toMatch(/no variables/);
  });

  it('uses a flat array for body-only variables', () => {
    const { body } = buildTemplateApiExample(
      tpl({
        body_text: 'Hi {{1}}, order {{2}} is confirmed.',
        sample_values: { body: ['Asha', 'A-1042'] },
      }),
    );
    expect(templateOf(body).params).toEqual(['Asha', 'A-1042']);
  });

  it('falls back to a visible placeholder when a sample is missing', () => {
    const { body } = buildTemplateApiExample(
      tpl({ body_text: 'Hi {{1}}, welcome aboard.' }),
    );
    expect(templateOf(body).params).toEqual(['<1>']);
  });

  it('switches to the structured form for a media header', () => {
    const { body, notes } = buildTemplateApiExample(
      tpl({
        header_type: 'image',
        header_media_url: 'https://cdn.example.com/a.jpg',
        body_text: 'Hi {{1}}, take a look.',
        sample_values: { body: ['Asha'] },
      }),
    );
    expect(templateOf(body).params).toEqual({
      body: ['Asha'],
      headerMediaUrl: 'https://cdn.example.com/a.jpg',
    });
    expect(notes.join(' ')).toMatch(/on every send/);
  });

  it('includes a location pin for a location header', () => {
    const { body } = buildTemplateApiExample(
      tpl({ header_type: 'location', body_text: 'On the way to you now.' }),
    );
    const params = templateOf(body).params as Record<string, unknown>;
    expect(params.headerLocation).toMatchObject({
      latitude: expect.any(String),
      longitude: expect.any(String),
    });
  });

  it('includes headerText for a variable text header', () => {
    const { body } = buildTemplateApiExample(
      tpl({
        header_type: 'text',
        header_content: 'New in: {{1}}',
        sample_values: { header: ['Summer'] },
        body_text: 'Plenty of new pieces landed today.',
      }),
    );
    expect(templateOf(body).params).toEqual({ headerText: 'Summer' });
  });

  it('keys values by name for a NAMED template', () => {
    const { body, notes } = buildTemplateApiExample(
      tpl({
        parameter_format: 'NAMED',
        body_text: 'Hi {{customer_name}}, order {{order_id}} is confirmed.',
        sample_values: { body: ['Asha', 'A-1042'] },
      }),
    );
    expect(templateOf(body).params).toEqual({
      bodyNamed: { customer_name: 'Asha', order_id: 'A-1042' },
    });
    expect(notes.join(' ')).toMatch(/order does not matter/);
  });

  it('adds buttonParams for a URL suffix and a copy code', () => {
    const { body, notes } = buildTemplateApiExample(
      tpl({
        body_text: 'Your order is ready to track.',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Stop' },
          {
            type: 'URL',
            text: 'Track',
            url: 'https://example.com/t/{{1}}',
            example: 'BD5512789',
          },
          { type: 'COPY_CODE', text: 'Copy code', example: 'SAVE20' },
        ],
      }),
    );
    expect(templateOf(body).params).toEqual({
      buttonParams: { 1: 'BD5512789', 2: 'SAVE20' },
    });
    expect(notes.join(' ')).toMatch(/URL button/);
  });

  it('emits one cards entry per carousel card', () => {
    const { body, notes } = buildTemplateApiExample(
      tpl({
        body_text: 'Our bestsellers this month are all in stock.',
        cards: [
          {
            header_format: 'image',
            header_media_url: 'https://cdn.example.com/1.jpg',
            body_text: 'Now {{1}} at {{2}} while stock lasts.',
            body_samples: ['Backpack', '2499'],
            buttons: [{ type: 'URL', text: 'View', url: 'https://example.com/p/1' }],
          },
          {
            header_format: 'image',
            header_media_url: 'https://cdn.example.com/2.jpg',
            body_text: 'Now {{1}} at {{2}} while stock lasts.',
            body_samples: ['Tote', '1899'],
            buttons: [{ type: 'URL', text: 'View', url: 'https://example.com/p/2' }],
          },
        ],
      }),
    );
    const params = templateOf(body).params as { cards: unknown[] };
    expect(params.cards).toEqual([
      {
        headerMediaUrl: 'https://cdn.example.com/1.jpg',
        body: ['Backpack', '2499'],
      },
      {
        headerMediaUrl: 'https://cdn.example.com/2.jpg',
        body: ['Tote', '1899'],
      },
    ]);
    expect(notes.join(' ')).toMatch(/one entry per carousel card \(2 here\)/);
  });

  it('warns when the template is not approved', () => {
    const { notes } = buildTemplateApiExample(tpl({ status: 'PENDING' }));
    expect(notes.join(' ')).toMatch(/only delivers APPROVED/);
  });

  it('produces runnable curl with the key placeholder and the body inline', () => {
    const { curl } = buildTemplateApiExample(tpl(), 'https://wa.example.in/');
    expect(curl).toContain("'https://wa.example.in/api/v1/messages'");
    expect(curl).toContain('Authorization: Bearer <YOUR_API_KEY>');
    expect(curl).toContain('"type": "template"');
    // Trailing slash on the base URL must not double up.
    expect(curl).not.toContain('.in//api');
  });
});

describe('every library starter gets a usable example', () => {
  it.each(TEMPLATE_LIBRARY.map((t) => [t.id, t] as const))('%s', (_id, entry) => {
    const payload = buildTemplateSubmitPayload(entry.form);
    const row = {
      ...tpl(),
      name: payload.name,
      category: payload.category,
      language: payload.language,
      header_type: payload.header_type,
      header_content: payload.header_content,
      header_media_url: payload.header_media_url,
      body_text: payload.body_text,
      footer_text: payload.footer_text,
      buttons: payload.buttons,
      cards: payload.cards,
      sample_values: payload.sample_values,
      parameter_format: payload.parameter_format,
    } as MessageTemplate;

    const { body, curl } = buildTemplateApiExample(row);
    expect(templateOf(body).name).toBe(payload.name);
    expect(curl).toContain('api/v1/messages');
    // The example must be valid JSON when parsed back out of the body.
    expect(() => JSON.parse(JSON.stringify(body))).not.toThrow();
  });
});
