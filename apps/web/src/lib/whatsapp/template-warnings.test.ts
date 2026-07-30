import { describe, it, expect } from 'vitest';
import { templateWarnings } from './template-warnings';
import { emptyCard, emptyTemplateForm } from './template-form';
import { TEMPLATE_LIBRARY } from './template-library';
import { buildTemplateSubmitPayload } from './template-form';

const form = (body: string, extra = {}) => ({
  ...emptyTemplateForm,
  body_text: body,
  ...extra,
});

describe('variable density', () => {
  // Boundaries probed against the live API — see template-warnings.ts.
  it('flags 2 variables in 4 words (Meta rejects this)', () => {
    const w = templateWarnings(form('Order {{1}} {{2}} confirmed today'));
    expect(w.map((x) => x.code)).toContain('variable_density');
  });

  it('does not flag 2 variables in 5 words (Meta accepts this)', () => {
    const w = templateWarnings(form('Order {{1}} for {{2}} is confirmed today'));
    expect(w.map((x) => x.code)).not.toContain('variable_density');
  });

  it('does not flag a long body with several variables', () => {
    const w = templateWarnings(
      form(
        'Your order with our store has now been confirmed and paid in full for {{1}} plus {{2}} plus {{3}} as noted',
      ),
    );
    expect(w.map((x) => x.code)).not.toContain('variable_density');
  });

  it('says nothing about a body with no variables', () => {
    expect(templateWarnings(form('Thanks for shopping with us.'))).toEqual([]);
  });
});

describe('adjacent variables', () => {
  it('flags placeholders separated only by space or punctuation', () => {
    const long =
      'Thanks for shopping with our store today, your order is confirmed and paid without issue at all regarding';
    for (const pair of ['{{1}} {{2}}', '{{1}}{{2}}', '{{1}}, {{2}}']) {
      const w = templateWarnings(form(`${long} ${pair} as recorded`));
      expect(w.map((x) => x.code)).toContain('adjacent_variables');
    }
  });

  it('does not flag placeholders separated by a word', () => {
    const w = templateWarnings(
      form(
        'Thanks for shopping with our store today, your order is confirmed regarding {{1}} and {{2}} as recorded',
      ),
    );
    expect(w.map((x) => x.code)).not.toContain('adjacent_variables');
  });
});

describe('carousel cards', () => {
  it('flags a dense card body, naming the card', () => {
    const w = templateWarnings({
      ...emptyTemplateForm,
      template_type: 'CAROUSEL',
      body_text: 'Our three bestsellers this month are all in stock and ready.',
      cards: [{ ...emptyCard(), body_text: 'Now {{1}} {{2}} here' }],
    });
    expect(w.some((x) => x.message.startsWith('Card 1'))).toBe(true);
  });
});

describe('the shipped library', () => {
  it('produces no warnings for any starter', () => {
    // The starters are the one set of templates we control end to end;
    // they should be exemplary, not merely legal.
    const noisy = TEMPLATE_LIBRARY.filter(
      (t) => templateWarnings(t.form).length > 0,
    ).map((t) => `${t.id}: ${templateWarnings(t.form)[0].message}`);
    expect(noisy).toEqual([]);
  });

  it('still builds a valid payload for each starter', () => {
    for (const t of TEMPLATE_LIBRARY) {
      expect(buildTemplateSubmitPayload(t.form).body_text.length).toBeGreaterThan(0);
    }
  });
});
