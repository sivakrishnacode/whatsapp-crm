import { describe, expect, it } from 'vitest';
import {
  parseBroadcastTemplateConfig,
  toMessageParams,
} from './broadcast-template.util';

describe('parseBroadcastTemplateConfig', () => {
  it('separates reserved send-time extras from the placeholder mapping', () => {
    const config = parseBroadcastTemplateConfig({
      '1': { type: 'field', value: 'name' },
      _headerMediaUrl: 'https://x.test/a.png',
      _headerText: 'Sale',
      _buttonParams: { '0': 'CODE10' },
    });

    expect(config.variables).toEqual({
      '1': { type: 'field', value: 'name' },
    });
    expect(config.headerMediaUrl).toBe('https://x.test/a.png');
    expect(config.headerText).toBe('Sale');
    // Meta's builder keys buttons by index, not by the string the Json
    // round-trip produces.
    expect(config.buttonParams).toEqual({ 0: 'CODE10' });
  });

  it('parses a broadcast created before any reserved key existed', () => {
    expect(parseBroadcastTemplateConfig(null)).toEqual({
      buttonParams: {},
      variables: {},
    });
  });

  it('drops a half-written header location instead of passing it on', () => {
    // Meta rejects the whole send for a malformed pin, which would turn
    // one bad field into every recipient failing.
    const config = parseBroadcastTemplateConfig({
      _headerLocation: { latitude: '12.9' },
    });
    expect(config.headerLocation).toBeUndefined();
  });

  it('keeps a complete header location', () => {
    const config = parseBroadcastTemplateConfig({
      _headerLocation: { latitude: '12.9', longitude: '77.5', name: 'Store' },
    });
    expect(config.headerLocation).toEqual({
      latitude: '12.9',
      longitude: '77.5',
      name: 'Store',
    });
  });
});

describe('toMessageParams', () => {
  it('omits absent extras rather than sending undefined', () => {
    const params = toMessageParams(parseBroadcastTemplateConfig({}));
    expect(params).toEqual({});
  });

  it('includes bodyNamed only for NAMED templates', () => {
    const config = parseBroadcastTemplateConfig({
      _headerText: 'Hi',
    });
    expect(toMessageParams(config)).toEqual({ headerText: 'Hi' });
    expect(toMessageParams(config, { customer: 'Asha' })).toEqual({
      headerText: 'Hi',
      bodyNamed: { customer: 'Asha' },
    });
  });
});
