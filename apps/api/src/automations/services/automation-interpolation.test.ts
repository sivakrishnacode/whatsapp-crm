import { describe, expect, it } from 'vitest';
import {
  interpolate,
  interpolateDeep,
  resolveToken,
  resolveValue,
} from './automation-interpolation.util';
import type { AutomationContext } from '../automation.types';

const ctx: AutomationContext = {
  message_text: 'I want a refund',
  conversation_id: 'conv-1',
  channel: 'whatsapp',
  vars: { plan: 'growth', count: 3 },
  contact: { name: 'Ada', phone: '+91 98765 43210', email: null },
  steps: {
    lookup: {
      status: 200,
      body: {
        order: { id: 'ord_42', total: 1299.5 },
        items: [{ sku: 'A1' }, { sku: 'B2' }],
      },
    },
  },
};

describe('interpolate — the original contract', () => {
  it('resolves the tokens that existed before step outputs', () => {
    expect(interpolate('Hi {{contact.name}} — {{message.text}}', ctx)).toBe(
      'Hi Ada — I want a refund',
    );
    expect(interpolate('{{vars.plan}}', ctx)).toBe('growth');
  });

  it('resolves an unknown token to an empty string, not verbatim', () => {
    // Load-bearing: a visible {{token}} in a customer-facing message
    // reads as a broken app, and Meta rejects template params containing
    // braces.
    expect(interpolate('Hi {{vars.nope}}!', ctx)).toBe('Hi !');
    expect(interpolate('{{ nonsense.deep.path }}', ctx)).toBe('');
  });

  it('leaves a string with no tokens untouched', () => {
    expect(interpolate('plain text', ctx)).toBe('plain text');
  });
});

describe('deep paths into step output', () => {
  it('reads a nested field from an earlier step', () => {
    expect(interpolate('{{ steps.lookup.body.order.id }}', ctx)).toBe('ord_42');
  });

  it('indexes into an array', () => {
    expect(interpolate('{{ steps.lookup.body.items.1.sku }}', ctx)).toBe('B2');
  });

  it('resolves a named lookup into an array to empty, not undefined', () => {
    expect(interpolate('{{ steps.lookup.body.items.sku }}', ctx)).toBe('');
  });

  it('renders an object as JSON rather than [object Object]', () => {
    expect(interpolate('{{ steps.lookup.body.order }}', ctx)).toBe(
      '{"id":"ord_42","total":1299.5}',
    );
  });
});

describe('filters', () => {
  it('default fills in for a blank value only', () => {
    expect(interpolate('Hi {{ contact.email | default: "there" }}', ctx)).toBe(
      'Hi there',
    );
    expect(interpolate('Hi {{ contact.name | default: "there" }}', ctx)).toBe(
      'Hi Ada',
    );
  });

  it('json escapes a value for pasting into a hand-written body', () => {
    const quoted: AutomationContext = { vars: { note: 'she said "hi"' } };
    expect(interpolate('{"n": {{ vars.note | json }}}', quoted)).toBe(
      '{"n": "she said \\"hi\\""}',
    );
  });

  it('digits strips phone formatting', () => {
    expect(interpolate('{{ contact.phone | digits }}', ctx)).toBe('919876543210');
  });

  it('chains filters left to right', () => {
    expect(interpolate('{{ contact.name | upper | truncate: 2 }}', ctx)).toBe(
      'AD…',
    );
  });

  it('passes the value through an unknown filter rather than blanking it', () => {
    // A typo'd filter name must not silently delete the data.
    expect(interpolate('{{ contact.name | wat }}', ctx)).toBe('Ada');
  });

  it('does not split a filter argument containing a pipe', () => {
    expect(
      interpolate('{{ contact.email | default: "a|b" }}', ctx),
    ).toBe('a|b');
  });
});

describe('resolveValue — type preservation', () => {
  it('keeps the underlying type when the template is exactly one token', () => {
    // The reason a JSON body can post `"qty": 3` instead of `"qty": "3"`.
    expect(resolveValue('{{ vars.count }}', ctx)).toBe(3);
    expect(resolveValue('{{ steps.lookup.body.order }}', ctx)).toEqual({
      id: 'ord_42',
      total: 1299.5,
    });
  });

  it('falls back to string interpolation when the token is embedded', () => {
    expect(resolveValue('qty: {{ vars.count }}', ctx)).toBe('qty: 3');
  });

  it('leaves non-strings alone', () => {
    expect(resolveValue(7, ctx)).toBe(7);
    expect(resolveValue(null, ctx)).toBe(null);
  });
});

describe('interpolateDeep — JSON bodies', () => {
  it('resolves values throughout a nested structure', () => {
    expect(
      interpolateDeep(
        {
          customer: '{{ contact.name }}',
          order_id: '{{ steps.lookup.body.order.id }}',
          qty: '{{ vars.count }}',
          nested: { skus: ['{{ steps.lookup.body.items.0.sku }}'] },
        },
        ctx,
      ),
    ).toEqual({
      customer: 'Ada',
      order_id: 'ord_42',
      qty: 3,
      nested: { skus: ['A1'] },
    });
  });

  it('interpolates object keys too', () => {
    expect(interpolateDeep({ '{{ vars.plan }}_id': 1 }, ctx)).toEqual({
      growth_id: 1,
    });
  });
});

describe('context namespaces', () => {
  it('exposes trigger facts', () => {
    expect(resolveToken('trigger.channel', ctx)).toBe('whatsapp');
    expect(resolveToken('trigger.message', ctx)).toBe('I want a refund');
  });

  it('exposes the conversation', () => {
    expect(resolveToken('conversation.id', ctx)).toBe('conv-1');
  });

  it('resolves now.* to UTC', () => {
    const iso = String(resolveToken('now.iso', ctx));
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(String(resolveToken('now.date', ctx))).toHaveLength(10);
  });

  it('handles a context with nothing in it', () => {
    expect(interpolate('{{ contact.name }}', undefined)).toBe('');
    expect(interpolate('{{ steps.a.b.c }}', {})).toBe('');
  });
});
