import type {
  CustomField,
  SegmentFilter,
  SegmentRule,
  SegmentRuleOperator,
} from '@/types';

/**
 * The dynamic-segment rule vocabulary, as the browser sees it.
 *
 * ⚠ THIS IS THE TYPESCRIPT HALF OF A CONTRACT WITH SQL.
 *   `contact_matches_segment_rule()` in migration 076 is the other half
 *   and is the one that actually decides who is in a segment. A field or
 *   operator added here and not there produces a rule that saves fine,
 *   renders fine, and silently matches nobody — which is the worst of
 *   the available failure modes, because an empty audience looks like an
 *   empty audience rather than like a bug.
 */

export interface RuleOperatorSpec {
  value: SegmentRuleOperator;
  label: string;
  /** False for is_set / is_not_set, which are complete on their own. */
  needsValue: boolean;
}

export type RuleValueInput = 'text' | 'tag' | 'source' | 'boolean' | 'date';

export interface RuleFieldSpec {
  value: string;
  label: string;
  group: 'Contact' | 'Activity' | 'Custom fields';
  operators: RuleOperatorSpec[];
  input: RuleValueInput;
}

const TEXT_OPERATORS: RuleOperatorSpec[] = [
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'is', label: 'is exactly', needsValue: true },
  { value: 'is_not', label: 'is not', needsValue: true },
  { value: 'is_set', label: 'is set', needsValue: false },
  { value: 'is_not_set', label: 'is empty', needsValue: false },
];

/** The fixed part of the vocabulary — everything that is not a custom field. */
export const BASE_RULE_FIELDS: RuleFieldSpec[] = [
  {
    value: 'tag',
    label: 'Tag',
    group: 'Contact',
    input: 'tag',
    operators: [
      { value: 'has', label: 'has', needsValue: true },
      { value: 'not_has', label: 'does not have', needsValue: true },
    ],
  },
  {
    value: 'has_phone',
    label: 'Phone number',
    group: 'Contact',
    input: 'boolean',
    operators: [{ value: 'is', label: 'is', needsValue: true }],
  },
  {
    value: 'source',
    label: 'Source',
    group: 'Contact',
    input: 'source',
    operators: [
      { value: 'is', label: 'is', needsValue: true },
      { value: 'is_not', label: 'is not', needsValue: true },
    ],
  },
  { value: 'name', label: 'Name', group: 'Contact', input: 'text', operators: TEXT_OPERATORS },
  { value: 'email', label: 'Email', group: 'Contact', input: 'text', operators: TEXT_OPERATORS },
  {
    value: 'company',
    label: 'Company',
    group: 'Contact',
    input: 'text',
    operators: TEXT_OPERATORS,
  },
  {
    value: 'created_at',
    label: 'Created',
    group: 'Activity',
    input: 'date',
    operators: [
      { value: 'after', label: 'after', needsValue: true },
      { value: 'before', label: 'before', needsValue: true },
    ],
  },
];

/** Mirrors CONTACT_SOURCES in apps/api/src/common/contacts/contact-source.ts. */
export const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: 'manual', label: 'Added manually' },
  { value: 'import', label: 'CSV import' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'web', label: 'Website chat' },
  { value: 'form', label: 'Form' },
  { value: 'facebook_lead', label: 'Facebook lead' },
  { value: 'api', label: 'API' },
  { value: 'broadcast', label: 'Broadcast' },
  { value: 'unknown', label: 'Unknown' },
];

/** Base fields plus one entry per custom field the workspace has defined. */
export function ruleFields(customFields: CustomField[]): RuleFieldSpec[] {
  return [
    ...BASE_RULE_FIELDS,
    ...customFields.map<RuleFieldSpec>((f) => ({
      value: `custom:${f.id}`,
      label: f.field_name,
      group: 'Custom fields',
      input: 'text',
      operators: TEXT_OPERATORS,
    })),
  ];
}

export function findRuleField(
  fields: RuleFieldSpec[],
  value: string,
): RuleFieldSpec | undefined {
  return fields.find((f) => f.value === value);
}

export function operatorNeedsValue(
  fields: RuleFieldSpec[],
  rule: SegmentRule,
): boolean {
  const field = findRuleField(fields, rule.field);
  const op = field?.operators.find((o) => o.value === rule.op);
  // Unknown operator: assume it needs a value, so the editor shows the
  // input rather than hiding a field the user cannot then fill in.
  return op ? op.needsValue : true;
}

/**
 * Is this rule complete enough to be evaluated?
 *
 * ⚠ Must agree with `segment_complete_rules()` in migration 076. The SQL
 * DROPS incomplete rules before matching, and if nothing survives the
 * segment resolves to NOBODY rather than everybody. This function exists
 * so the UI can say that out loud instead of letting someone save a
 * filter that quietly matches no one.
 */
export function isRuleComplete(rule: SegmentRule): boolean {
  if (!rule.field || !rule.op) return false;
  if (rule.op === 'is_set' || rule.op === 'is_not_set') return true;
  return Boolean(rule.value && rule.value.trim());
}

export function completeRules(filter: SegmentFilter | null | undefined): SegmentRule[] {
  return (filter?.rules ?? []).filter(isRuleComplete);
}

/** A short human sentence for a rule, used in summaries and chips. */
export function describeRule(
  rule: SegmentRule,
  fields: RuleFieldSpec[],
  lookupTag: (id: string) => string | undefined,
): string {
  const field = findRuleField(fields, rule.field);
  const fieldLabel = field?.label ?? rule.field;
  const opLabel =
    field?.operators.find((o) => o.value === rule.op)?.label ?? rule.op;

  if (rule.op === 'is_set' || rule.op === 'is_not_set') {
    return `${fieldLabel} ${opLabel}`;
  }
  if (field?.input === 'tag') {
    return `${fieldLabel} ${opLabel} ${lookupTag(rule.value ?? '') ?? 'unknown tag'}`;
  }
  if (field?.input === 'boolean') {
    return rule.value === 'true'
      ? `${fieldLabel} is set`
      : `${fieldLabel} is empty`;
  }
  if (field?.input === 'source') {
    const label = SOURCE_OPTIONS.find((s) => s.value === rule.value)?.label;
    return `${fieldLabel} ${opLabel} ${label ?? rule.value ?? ''}`;
  }
  return `${fieldLabel} ${opLabel} "${rule.value ?? ''}"`;
}

/** A fresh rule for the field the picker defaults to. */
export function blankRule(fields: RuleFieldSpec[]): SegmentRule {
  const field = fields[0];
  return {
    field: field?.value ?? 'name',
    op: field?.operators[0]?.value ?? 'contains',
    value: field?.input === 'boolean' ? 'true' : '',
  };
}
