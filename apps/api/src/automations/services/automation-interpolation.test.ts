import { describe, expect, it } from 'vitest';
import { interpolate } from './automation-interpolation.util';

describe('interpolate', () => {
  it('resolves {{message.text}} from context', () => {
    expect(
      interpolate('Reply: {{message.text}}', { message_text: 'hello' }),
    ).toBe('Reply: hello');
  });

  it('resolves {{vars.<key>}} from context', () => {
    expect(interpolate('Hi {{vars.name}}!', { vars: { name: 'Ada' } })).toBe(
      'Hi Ada!',
    );
  });

  it('resolves an unknown namespace to an empty string', () => {
    expect(interpolate('{{unknown.thing}}', { message_text: 'x' })).toBe('');
  });

  it('resolves a missing var key to an empty string', () => {
    expect(interpolate('{{vars.missing}}', { vars: {} })).toBe('');
  });

  it('passes through literal text with no placeholders', () => {
    expect(interpolate('just plain text', undefined)).toBe('just plain text');
  });

  it('handles multiple placeholders in one string', () => {
    expect(
      interpolate('{{vars.a}} and {{vars.b}}', { vars: { a: '1', b: '2' } }),
    ).toBe('1 and 2');
  });
});
