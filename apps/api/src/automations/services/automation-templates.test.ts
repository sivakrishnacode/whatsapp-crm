import { describe, expect, it } from 'vitest';
import { AUTOMATION_TEMPLATES, getTemplate } from './automation-templates';

describe('getTemplate', () => {
  it('returns the right shape for every known slug', () => {
    for (const slug of Object.keys(AUTOMATION_TEMPLATES)) {
      const tpl = getTemplate(slug);
      expect(tpl).not.toBeNull();
      expect(tpl?.slug).toBe(slug);
      expect(tpl?.steps.length).toBeGreaterThan(0);
    }
  });

  it('returns null for an unknown slug', () => {
    expect(getTemplate('not_a_real_template')).toBeNull();
  });
});
