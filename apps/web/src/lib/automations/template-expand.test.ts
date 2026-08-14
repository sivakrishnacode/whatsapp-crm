import { describe, expect, it } from 'vitest';

import { flattenSteps } from '@/lib/automations/graph';
import { STEP_META } from '@/lib/automations/step-meta';
import { expandFromSeeds, templateToBuilderSeed } from '@/lib/automations/template-expand';
import {
  AUTOMATION_TEMPLATES,
  REQUIREMENTS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_SLUGS,
  getTemplate,
} from '@/lib/automations/templates';
import type { AutomationTriggerType } from '@/types';

const CATEGORY_IDS = new Set(TEMPLATE_CATEGORIES.map((c) => c.id));

describe('expandFromSeeds', () => {
  /**
   * The regression that motivated this file. A key is the canvas node id
   * AND the `{{ steps.<key>.… }}` token path — two steps sharing one
   * means React Flow drops a node and a token reads the wrong step.
   */
  it('gives repeated step types distinct keys', () => {
    const steps = expandFromSeeds([
      { step_type: 'send_message', step_config: { text: 'a' }, branch: null, parent_index: null },
      { step_type: 'wait', step_config: { amount: 1, unit: 'days' }, branch: null, parent_index: null },
      { step_type: 'send_message', step_config: { text: 'b' }, branch: null, parent_index: null },
      { step_type: 'send_message', step_config: { text: 'c' }, branch: null, parent_index: null },
    ]);
    const keys = steps.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('nests a seed under its condition parent, on the named branch', () => {
    const steps = expandFromSeeds([
      { step_type: 'condition', step_config: {}, branch: null, parent_index: null },
      { step_type: 'send_message', step_config: { text: 'yes' }, branch: 'yes', parent_index: 0 },
      { step_type: 'send_message', step_config: { text: 'no' }, branch: 'no', parent_index: 0 },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].branches?.yes).toHaveLength(1);
    expect(steps[0].branches?.no).toHaveLength(1);
    expect(steps[0].branches?.yes[0].step_config.text).toBe('yes');
  });

  it('keeps keys unique across branches, not just within one', () => {
    const steps = expandFromSeeds([
      { step_type: 'condition', step_config: {}, branch: null, parent_index: null },
      { step_type: 'send_message', step_config: { text: 'y' }, branch: 'yes', parent_index: 0 },
      { step_type: 'send_message', step_config: { text: 'n' }, branch: 'no', parent_index: 0 },
    ]);
    const keys = flattenSteps(steps).map((f) => f.step.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('treats a dangling parent_index as a root rather than dropping the step', () => {
    const steps = expandFromSeeds([
      { step_type: 'send_message', step_config: {}, branch: 'yes', parent_index: 7 },
    ]);
    expect(steps).toHaveLength(1);
  });
});

describe('the template catalogue', () => {
  it('ships at least 20 templates', () => {
    expect(TEMPLATE_SLUGS.length).toBeGreaterThanOrEqual(20);
  });

  it('keys every entry by its own slug', () => {
    for (const slug of TEMPLATE_SLUGS) {
      expect(AUTOMATION_TEMPLATES[slug].slug).toBe(slug);
      expect(getTemplate(slug)?.slug).toBe(slug);
    }
  });

  it('returns null for an unknown slug', () => {
    expect(getTemplate('not_a_real_template')).toBeNull();
  });

  it('gives every template a real category and at least one step', () => {
    for (const slug of TEMPLATE_SLUGS) {
      const t = AUTOMATION_TEMPLATES[slug];
      expect(CATEGORY_IDS.has(t.category), `${slug} category`).toBe(true);
      expect(t.steps.length, `${slug} steps`).toBeGreaterThan(0);
      expect(t.name.length, `${slug} name`).toBeGreaterThan(0);
      expect(t.description.length, `${slug} description`).toBeGreaterThan(0);
    }
  });

  it('only uses step types the editor knows how to render', () => {
    for (const slug of TEMPLATE_SLUGS) {
      for (const seed of AUTOMATION_TEMPLATES[slug].steps) {
        expect(STEP_META[seed.step_type], `${slug}: ${seed.step_type}`).toBeDefined();
      }
    }
  });

  it('only declares requirements the readiness check can resolve', () => {
    for (const slug of TEMPLATE_SLUGS) {
      for (const id of AUTOMATION_TEMPLATES[slug].requirements ?? []) {
        expect(REQUIREMENTS[id], `${slug}: ${id}`).toBeDefined();
      }
    }
  });

  /**
   * Only a branching step owns branches, so a seed pointing at anything
   * else would be silently dropped by the builder — the steps would
   * simply not appear on the canvas.
   */
  it('only nests seeds under a branching parent', () => {
    for (const slug of TEMPLATE_SLUGS) {
      const seeds = AUTOMATION_TEMPLATES[slug].steps;
      seeds.forEach((seed, i) => {
        if (seed.parent_index == null) return;
        const parent = seeds[seed.parent_index];
        expect(parent, `${slug} step ${i} parent`).toBeDefined();
        expect(
          STEP_META[parent.step_type].branching,
          `${slug} step ${i} nests under ${parent.step_type}`,
        ).toBe(true);
        expect(seed.parent_index).toBeLessThan(i);
      });
    }
  });

  /**
   * A template that names a real id would be naming a row in whichever
   * workspace it was authored in. Everything account-scoped is blank on
   * purpose, and declared in `requirements` instead.
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
    for (const slug of TEMPLATE_SLUGS) {
      for (const seed of AUTOMATION_TEMPLATES[slug].steps) {
        const cfg = seed.step_config as Record<string, unknown>;
        for (const key of ID_KEYS) {
          if (key in cfg) expect(cfg[key], `${slug}.${key}`).toBe('');
        }
      }
    }
  });

  it('scopes an Instagram-only trigger to Instagram', () => {
    const LOCKED: Partial<Record<AutomationTriggerType, string>> = {
      instagram_comment: 'instagram',
      instagram_story_reply: 'instagram',
      web_chat_started: 'web',
    };
    for (const slug of TEMPLATE_SLUGS) {
      const t = AUTOMATION_TEMPLATES[slug];
      const locked = LOCKED[t.trigger_type];
      if (!locked) continue;
      expect(t.channels, `${slug} channels`).toEqual([locked]);
    }
  });

  it('gives a keyword trigger at least one keyword', () => {
    for (const slug of TEMPLATE_SLUGS) {
      const t = AUTOMATION_TEMPLATES[slug];
      if (t.trigger_type !== 'keyword_match') continue;
      const keywords = (t.trigger_config as { keywords?: string[] }).keywords;
      expect(keywords?.length, `${slug} keywords`).toBeGreaterThan(0);
    }
  });
});

describe('templateToBuilderSeed', () => {
  it('opens every template as an inactive draft with unique step keys', () => {
    for (const slug of TEMPLATE_SLUGS) {
      const seed = templateToBuilderSeed(AUTOMATION_TEMPLATES[slug]);
      expect(seed.is_active, `${slug} is_active`).toBe(false);
      const keys = flattenSteps(seed.steps).map((f) => f.step.key);
      expect(new Set(keys).size, `${slug} unique keys`).toBe(keys.length);
      expect(keys.length, `${slug} step count`).toBeGreaterThan(0);
    }
  });

  it('carries the template channels through', () => {
    const seed = templateToBuilderSeed(AUTOMATION_TEMPLATES.web_chat_greeting);
    expect(seed.channels).toEqual(['web']);
  });

  /**
   * Templates that reference an earlier step by token must reference a
   * key the expansion actually mints — `{{ steps.http_request.ok }}` is
   * silently empty if the step ended up as `http_request_2`.
   */
  it('resolves every {{ steps.<key> }} token to a step that exists', () => {
    for (const slug of TEMPLATE_SLUGS) {
      const seed = templateToBuilderSeed(AUTOMATION_TEMPLATES[slug]);
      const keys = new Set(flattenSteps(seed.steps).map((f) => f.step.key));
      const json = JSON.stringify(seed.steps);
      for (const [, key] of json.matchAll(/steps\.([a-z0-9_]+)\./g)) {
        expect(keys.has(key), `${slug} references steps.${key}`).toBe(true);
      }
    }
  });
});
