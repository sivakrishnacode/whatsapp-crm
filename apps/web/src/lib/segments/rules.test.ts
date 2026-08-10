import { describe, expect, it } from 'vitest';
import type { CustomField, SegmentRule, Tag } from '@/types';
import {
  BASE_RULE_FIELDS,
  blankRule,
  completeRules,
  describeRule,
  findRuleField,
  isRuleComplete,
  operatorNeedsValue,
  ruleFields,
  SOURCE_OPTIONS,
} from './rules';

/**
 * ⚠ THESE TESTS GUARD A CONTRACT WITH SQL.
 *
 * `contact_matches_segment_rule()` and `segment_complete_rules()` in
 * migration 076 are what actually decide who is in a dynamic segment.
 * This module is the browser's copy of the same vocabulary, and the two
 * failing to agree does not throw — it produces a segment that saves
 * fine, renders fine, and silently matches the wrong people (or nobody).
 *
 * So the assertions below are mostly about the RULES OF THE CONTRACT
 * rather than about this file's internals: which fields exist, which
 * operators need a value, and what "incomplete" means.
 */

const TAG: Tag = {
  id: 'tag-1',
  user_id: 'u-1',
  name: 'VIP',
  color: '#f00',
  created_at: '2026-01-01T00:00:00Z',
};

const CUSTOM_FIELD: CustomField = {
  id: 'cf-1',
  user_id: 'u-1',
  account_id: 'acc-1',
  field_name: 'Plan tier',
  field_type: 'text',
  created_at: '2026-01-01T00:00:00Z',
};

const lookupTag = (id: string) => (id === TAG.id ? TAG.name : undefined);

describe('the field vocabulary matches migration 076', () => {
  it('offers exactly the fields contact_matches_segment_rule understands', () => {
    // Adding one here without adding it there yields a rule that matches
    // nobody, so this list is a checklist, not a snapshot for its own sake.
    expect(BASE_RULE_FIELDS.map((f) => f.value).sort()).toEqual([
      'company',
      'created_at',
      'email',
      'has_phone',
      'name',
      'source',
      'tag',
    ]);
  });

  it('gives each field only operators the SQL branch for it implements', () => {
    expect(findRuleField(BASE_RULE_FIELDS, 'tag')?.operators.map((o) => o.value))
      .toEqual(['has', 'not_has']);
    expect(
      findRuleField(BASE_RULE_FIELDS, 'created_at')?.operators.map((o) => o.value),
    ).toEqual(['after', 'before']);
    expect(
      findRuleField(BASE_RULE_FIELDS, 'has_phone')?.operators.map((o) => o.value),
    ).toEqual(['is']);
  });

  it('lists custom fields under the custom: prefix the SQL parses', () => {
    const fields = ruleFields([CUSTOM_FIELD]);
    const custom = fields.find((f) => f.label === 'Plan tier');
    // substring(field FROM 8)::uuid in the SQL depends on this exact shape.
    expect(custom?.value).toBe('custom:cf-1');
    expect(custom?.group).toBe('Custom fields');
  });

  it('mirrors the CONTACT_SOURCES list the contacts.source column allows', () => {
    expect(SOURCE_OPTIONS.map((s) => s.value).sort()).toEqual([
      'api',
      'broadcast',
      'facebook_lead',
      'form',
      'import',
      'instagram',
      'manual',
      'unknown',
      'web',
      'whatsapp',
    ]);
  });
});

describe('isRuleComplete agrees with segment_complete_rules', () => {
  it('treats is_set / is_not_set as complete with no value', () => {
    expect(isRuleComplete({ field: 'email', op: 'is_set' })).toBe(true);
    expect(isRuleComplete({ field: 'email', op: 'is_not_set', value: '' })).toBe(
      true,
    );
  });

  it('requires a value for every other operator', () => {
    expect(isRuleComplete({ field: 'name', op: 'contains', value: '' })).toBe(
      false,
    );
    expect(isRuleComplete({ field: 'name', op: 'contains', value: '  ' })).toBe(
      false,
    );
    expect(isRuleComplete({ field: 'name', op: 'contains', value: 'a' })).toBe(
      true,
    );
  });

  it('rejects a rule with no field or no operator', () => {
    expect(isRuleComplete({ field: '', op: 'is', value: 'x' })).toBe(false);
    expect(
      isRuleComplete({ field: 'name', op: '' as SegmentRule['op'], value: 'x' }),
    ).toBe(false);
  });

  it('drops incomplete rules rather than reinterpreting them', () => {
    // The SQL drops them, and if nothing survives the segment resolves
    // to NOBODY. Treating an unfinished rule as permissive would be
    // correct under match=all and catastrophic under match=any, where it
    // means the entire contact list.
    const filter = {
      match: 'any' as const,
      rules: [
        { field: 'name', op: 'contains' as const, value: 'asha' },
        { field: 'tag', op: 'has' as const, value: '' },
        { field: '', op: 'is' as const, value: 'x' },
      ],
    };
    expect(completeRules(filter)).toEqual([
      { field: 'name', op: 'contains', value: 'asha' },
    ]);
  });

  it('returns nothing for an absent or empty filter', () => {
    expect(completeRules(undefined)).toEqual([]);
    expect(completeRules({})).toEqual([]);
    expect(completeRules({ match: 'all', rules: [] })).toEqual([]);
  });
});

describe('operatorNeedsValue', () => {
  it('is false only for the two value-free operators', () => {
    expect(
      operatorNeedsValue(BASE_RULE_FIELDS, { field: 'email', op: 'is_set' }),
    ).toBe(false);
    expect(
      operatorNeedsValue(BASE_RULE_FIELDS, { field: 'email', op: 'contains' }),
    ).toBe(true);
  });

  it('assumes a value is needed for an unknown operator', () => {
    // Showing an input the rule may not need beats hiding one it does —
    // the second leaves a field the user cannot fill in.
    expect(
      operatorNeedsValue(BASE_RULE_FIELDS, {
        field: 'email',
        op: 'weird' as SegmentRule['op'],
      }),
    ).toBe(true);
  });
});

describe('describeRule', () => {
  const fields = ruleFields([CUSTOM_FIELD]);

  it('names the tag instead of showing its uuid', () => {
    expect(
      describeRule({ field: 'tag', op: 'has', value: 'tag-1' }, fields, lookupTag),
    ).toBe('Tag has VIP');
  });

  it('says so when the tag no longer exists', () => {
    expect(
      describeRule({ field: 'tag', op: 'has', value: 'gone' }, fields, lookupTag),
    ).toContain('unknown tag');
  });

  it('reads has_phone as present/empty rather than true/false', () => {
    expect(
      describeRule(
        { field: 'has_phone', op: 'is', value: 'true' },
        fields,
        lookupTag,
      ),
    ).toBe('Phone number is set');
    expect(
      describeRule(
        { field: 'has_phone', op: 'is', value: 'false' },
        fields,
        lookupTag,
      ),
    ).toBe('Phone number is empty');
  });

  it('uses the source label, not the stored token', () => {
    expect(
      describeRule(
        { field: 'source', op: 'is', value: 'facebook_lead' },
        fields,
        lookupTag,
      ),
    ).toBe('Source is Facebook lead');
  });

  it('omits the value for value-free operators', () => {
    expect(
      describeRule({ field: 'email', op: 'is_not_set' }, fields, lookupTag),
    ).toBe('Email is empty');
  });

  it('uses the custom field’s name', () => {
    expect(
      describeRule(
        { field: 'custom:cf-1', op: 'is', value: 'Gold' },
        fields,
        lookupTag,
      ),
    ).toBe('Plan tier is exactly "Gold"');
  });
});

describe('blankRule', () => {
  it('starts on a field/operator pair that is valid together', () => {
    const fields = ruleFields([]);
    const rule = blankRule(fields);
    const spec = findRuleField(fields, rule.field);
    expect(spec?.operators.map((o) => o.value)).toContain(rule.op);
  });

  it('pre-fills the boolean default so a has_phone rule is never half-built', () => {
    const booleanFirst = BASE_RULE_FIELDS.filter(
      (f) => f.value === 'has_phone',
    );
    expect(blankRule(booleanFirst).value).toBe('true');
    expect(isRuleComplete(blankRule(booleanFirst))).toBe(true);
  });
});
