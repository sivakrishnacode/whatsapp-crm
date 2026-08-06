import { describe, expect, it } from 'vitest';

import {
  actionToolDefinition,
  buildActionRequest,
  parseActionParameters,
  type AgentAction,
} from './actions';
import { AiError } from '../types';

/**
 * The model supplies parameter VALUES; the admin supplies everything
 * else. These tests pin the boundary — an interpolation that let a value
 * add a query parameter, escape a path segment or break the JSON body
 * would turn a configured endpoint into an arbitrary one.
 */

const action: AgentAction = {
  id: 'a1',
  name: 'check_stock',
  description: 'Check stock for a SKU',
  method: 'GET',
  url: 'https://erp.acme.test/stock/{sku}',
  headers: { Authorization: 'Bearer x' },
  parameters: [
    { name: 'sku', type: 'string', description: 'SKU', required: true, in: 'path' },
    { name: 'store', type: 'string', description: 'Store', required: false, in: 'query' },
  ],
  timeoutMs: 8000,
};

describe('buildActionRequest', () => {
  it('encodes path values so they cannot escape their segment', () => {
    const built = buildActionRequest(action, { sku: '../admin?x=1' });
    expect(built.url).toBe(
      'https://erp.acme.test/stock/..%2Fadmin%3Fx%3D1',
    );
  });

  it('encodes query values instead of splicing them', () => {
    const built = buildActionRequest(action, {
      sku: 'A-1',
      store: 'delhi&admin=true',
    });
    const url = new URL(built.url);
    expect(url.searchParams.get('store')).toBe('delhi&admin=true');
    expect(url.searchParams.get('admin')).toBeNull();
  });

  it('throws when a required parameter is missing', () => {
    expect(() => buildActionRequest(action, {})).toThrow(AiError);
  });

  it('throws when a URL placeholder has no matching path parameter', () => {
    const broken: AgentAction = {
      ...action,
      url: 'https://erp.acme.test/stock/{sku}/{warehouse}',
    };
    expect(() => buildActionRequest(broken, { sku: 'A-1' })).toThrow(
      /warehouse/,
    );
  });

  it('sends body parameters as JSON on a write, and none on a GET', () => {
    const post: AgentAction = {
      ...action,
      method: 'POST',
      url: 'https://erp.acme.test/tickets',
      parameters: [
        { name: 'subject', type: 'string', description: '', required: true, in: 'body' },
        { name: 'priority', type: 'number', description: '', required: false, in: 'body' },
      ],
    };

    const built = buildActionRequest(post, { subject: 'Broken "grinder"', priority: '2' });
    expect(built.method).toBe('POST');
    expect(JSON.parse(built.body!)).toEqual({
      subject: 'Broken "grinder"',
      priority: 2,
    });

    const get = buildActionRequest(
      { ...post, method: 'GET' },
      { subject: 'x' },
    );
    expect(get.body).toBeUndefined();
  });

  it('drops a non-numeric value for a number parameter', () => {
    const post: AgentAction = {
      ...action,
      method: 'POST',
      url: 'https://erp.acme.test/tickets',
      parameters: [
        { name: 'qty', type: 'number', description: '', required: false, in: 'body' },
      ],
    };
    const built = buildActionRequest(post, { qty: 'lots' });
    expect(built.body).toBeUndefined();
  });
});

describe('parseActionParameters', () => {
  it('rejects malformed names, duplicates and caps the count', () => {
    const parsed = parseActionParameters([
      { name: 'ok_one', type: 'string' },
      { name: 'ok_one', type: 'string' }, // duplicate
      { name: '2bad', type: 'string' }, // leading digit
      { name: 'has space', type: 'string' },
      { name: 'drop-me', type: 'string' }, // hyphen
      ...Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, type: 'string' })),
    ]);

    expect(parsed.filter((p) => p.name === 'ok_one')).toHaveLength(1);
    expect(parsed.some((p) => p.name === '2bad')).toBe(false);
    expect(parsed.some((p) => p.name === 'has space')).toBe(false);
    expect(parsed.length).toBeLessThanOrEqual(12);
  });

  it('defaults type to string and location to query', () => {
    const [param] = parseActionParameters([{ name: 'q', type: 'weird', in: 'header' }]);
    expect(param.type).toBe('string');
    expect(param.in).toBe('query');
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(parseActionParameters(null)).toEqual([]);
    expect(parseActionParameters({ name: 'q' })).toEqual([]);
  });
});

describe('actionToolDefinition', () => {
  it('lists only required parameters in `required`', () => {
    const definition = actionToolDefinition(action);
    expect(definition.name).toBe('check_stock');
    expect(definition.parameters.required).toEqual(['sku']);
    expect(Object.keys(definition.parameters.properties)).toEqual(['sku', 'store']);
  });

  it('omits `required` entirely when nothing is required', () => {
    const definition = actionToolDefinition({
      ...action,
      parameters: [
        { name: 'q', type: 'string', description: '', required: false, in: 'query' },
      ],
    });
    expect(definition.parameters.required).toBeUndefined();
  });
});
