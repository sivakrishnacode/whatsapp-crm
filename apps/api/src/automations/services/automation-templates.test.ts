import { describe, expect, it } from 'vitest';
import { AUTOMATION_TEMPLATES, getTemplate } from './automation-templates';

/**
 * This file is a hand-maintained mirror of the web catalogue (see its
 * header). These checks are the ones that would catch a bad mirror
 * without being able to import across the app boundary: the shape has to
 * be right, and nothing may reference a row in whichever workspace the
 * template was authored in.
 *
 * The web copy has the matching suite in
 * apps/web/src/lib/automations/template-expand.test.ts.
 */

const SLUGS = Object.keys(AUTOMATION_TEMPLATES);

/** Step types that own yes/no branches. Mirrors STEP_META.branching. */
const BRANCHING = new Set(['condition', 'random_split']);

describe('getTemplate', () => {
  it('returns the right shape for every known slug', () => {
    for (const slug of SLUGS) {
      const tpl = getTemplate(slug);
      expect(tpl).not.toBeNull();
      expect(tpl?.slug).toBe(slug);
      expect(tpl?.steps.length).toBeGreaterThan(0);
      expect(tpl?.name.length).toBeGreaterThan(0);
    }
  });

  it('returns null for an unknown slug', () => {
    expect(getTemplate('not_a_real_template')).toBeNull();
  });
});

describe('the catalogue', () => {
  it('ships at least 20 templates', () => {
    expect(SLUGS.length).toBeGreaterThanOrEqual(20);
  });

  /**
   * A template naming a real id would be naming a row in whichever
   * workspace it was written in. Everything account-scoped is blank on
   * purpose — the web gallery declares it as a requirement instead, and
   * the builder's pickers fill it in.
   */
  it('never ships a hard-coded workspace id', () => {
    const ID_KEYS = [
      'tag_id',
      'segment_id',
      'pipeline_id',
      'stage_id',
      'connection_id',
      'form_id',
      'appointment_type_id',
      'flow_id',
      'automation_id',
      'agent_id',
      'user_id',
    ];
    for (const slug of SLUGS) {
      for (const seed of AUTOMATION_TEMPLATES[slug].steps) {
        const cfg = seed.step_config as Record<string, unknown>;
        for (const key of ID_KEYS) {
          if (key in cfg) expect(cfg[key], `${slug}.${key}`).toBe('');
        }
      }
    }
  });

  /**
   * `parent_index` is resolved positionally by the seed expander, so a
   * forward reference or a non-branching parent silently drops the step
   * — it just never appears on the canvas.
   */
  it('only nests a seed under an earlier, branching parent', () => {
    for (const slug of SLUGS) {
      const seeds = AUTOMATION_TEMPLATES[slug].steps;
      seeds.forEach((seed, i) => {
        if (seed.parent_index == null) return;
        expect(seed.parent_index, `${slug} step ${i}`).toBeLessThan(i);
        const parent = seeds[seed.parent_index];
        expect(parent, `${slug} step ${i} parent`).toBeDefined();
        expect(
          BRANCHING.has(parent.step_type),
          `${slug} step ${i} nests under ${parent.step_type}`,
        ).toBe(true);
      });
    }
  });

  it('gives a keyword trigger at least one keyword', () => {
    for (const slug of SLUGS) {
      const t = AUTOMATION_TEMPLATES[slug];
      if (t.trigger_type !== 'keyword_match') continue;
      const keywords = (t.trigger_config as { keywords?: string[] }).keywords;
      expect(keywords?.length, `${slug} keywords`).toBeGreaterThan(0);
    }
  });
});
