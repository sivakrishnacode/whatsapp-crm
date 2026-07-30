import { describe, it, expect } from 'vitest';
import { renderTemplateBody } from './template-send-builder.util';

describe('renderTemplateBody', () => {
  it('returns a variable-free body unchanged', () => {
    expect(renderTemplateBody('Hello Customer, your order is placed')).toBe(
      'Hello Customer, your order is placed',
    );
  });

  it('substitutes placeholders positionally', () => {
    expect(
      renderTemplateBody('Hi {{1}}, order {{2}} ships today', {
        body: ['Siva', 'A-1042'],
      }),
    ).toBe('Hi Siva, order A-1042 ships today');
  });

  it('repeats a value when the same placeholder appears twice', () => {
    expect(
      renderTemplateBody('{{1}}, we mean it {{1}}', { body: ['Thanks'] }),
    ).toBe('Thanks, we mean it Thanks');
  });

  it('leaves placeholders verbatim when values are missing or blank', () => {
    // A partially-filled body stays readable instead of collapsing to
    // gaps — this text is what the inbox shows for the sent message.
    expect(
      renderTemplateBody('Hi {{1}}, ref {{2}}', { body: ['Siva', '  '] }),
    ).toBe('Hi Siva, ref {{2}}');
    expect(renderTemplateBody('Hi {{1}}')).toBe('Hi {{1}}');
  });

  it('ignores surplus values', () => {
    expect(renderTemplateBody('Hi {{1}}', { body: ['Siva', 'unused'] })).toBe(
      'Hi Siva',
    );
  });
});
