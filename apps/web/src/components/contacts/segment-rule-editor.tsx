'use client';

import type { CustomField, SegmentFilter, SegmentRule, Tag } from '@/types';
import {
  blankRule,
  findRuleField,
  isRuleComplete,
  operatorNeedsValue,
  ruleFields,
  SOURCE_OPTIONS,
  type RuleFieldSpec,
} from '@/lib/segments/rules';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, Plus, X } from 'lucide-react';

interface SegmentRuleEditorProps {
  filter: SegmentFilter;
  onChange: (filter: SegmentFilter) => void;
  tags: Tag[];
  customFields: CustomField[];
}

/**
 * The rule builder behind a dynamic segment.
 *
 * The one behaviour worth knowing about: an incomplete rule is DROPPED
 * before matching (see `segment_complete_rules` in migration 076), and a
 * filter with nothing left resolves to nobody rather than everybody.
 * That is the safe reading — under "match any", treating an unfinished
 * rule as permissive would silently mean the whole contact list — but it
 * is not what someone half-way through building a filter expects, so the
 * editor says it out loud.
 */
export function SegmentRuleEditor({
  filter,
  onChange,
  tags,
  customFields,
}: SegmentRuleEditorProps) {
  const fields = ruleFields(customFields);
  const rules = filter.rules ?? [];
  const match = filter.match ?? 'all';
  const incomplete = rules.filter((r) => !isRuleComplete(r)).length;
  const usable = rules.length - incomplete;

  function setRules(next: SegmentRule[]) {
    onChange({ ...filter, rules: next });
  }

  function updateRule(index: number, patch: Partial<SegmentRule>) {
    setRules(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  /**
   * Changing the field resets the operator and the value together.
   * Carrying either across is how you end up with `tag contains "xyz"`,
   * which saves happily and matches nobody.
   */
  function changeField(index: number, fieldValue: string) {
    const spec = findRuleField(fields, fieldValue);
    updateRule(index, {
      field: fieldValue,
      op: spec?.operators[0]?.value ?? 'contains',
      value: spec?.input === 'boolean' ? 'true' : '',
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Include contacts matching</span>
        <Select
          value={match}
          onValueChange={(v: string | null) =>
            onChange({ ...filter, match: v === 'any' ? 'any' : 'all' })
          }
        >
          <SelectTrigger className="h-8 w-[150px] bg-muted/20 border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-card border-border">
            <SelectItem value="all">all of the rules</SelectItem>
            <SelectItem value="any">any of the rules</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {rules.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
          No rules yet. A filter with no rules matches nobody.
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, index) => (
            <RuleRow
              key={index}
              rule={rule}
              fields={fields}
              tags={tags}
              onFieldChange={(v) => changeField(index, v)}
              onChange={(patch) => updateRule(index, patch)}
              onRemove={() => setRules(rules.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setRules([...rules, blankRule(fields)])}
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add rule
      </Button>

      {incomplete > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {incomplete} unfinished {incomplete === 1 ? 'rule is' : 'rules are'}{' '}
            ignored when this segment is resolved.
            {usable === 0 &&
              ' With no usable rules left, this segment matches nobody.'}
          </span>
        </p>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  fields,
  tags,
  onFieldChange,
  onChange,
  onRemove,
}: {
  rule: SegmentRule;
  fields: RuleFieldSpec[];
  tags: Tag[];
  onFieldChange: (value: string) => void;
  onChange: (patch: Partial<SegmentRule>) => void;
  onRemove: () => void;
}) {
  const spec = findRuleField(fields, rule.field);
  const needsValue = operatorNeedsValue(fields, rule);
  const groups = ['Contact', 'Activity', 'Custom fields'] as const;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/10 p-2">
      <Select
        value={rule.field}
        onValueChange={(v: string | null) => onFieldChange(v ?? rule.field)}
      >
        <SelectTrigger className="h-8 w-[150px] bg-background border-border">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-card border-border">
          {groups.map((group) => {
            const inGroup = fields.filter((f) => f.group === group);
            if (inGroup.length === 0) return null;
            return (
              <SelectGroup key={group}>
                <SelectLabel>{group}</SelectLabel>
                {inGroup.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })}
        </SelectContent>
      </Select>

      <Select
        value={rule.op}
        onValueChange={(v: string | null) =>
          onChange({
            op: (v ?? rule.op) as SegmentRule['op'],
            // is_set / is_not_set carry no value; clearing it keeps the
            // stored rule honest rather than leaving a stale operand
            // behind that a future edit might resurrect.
            ...(v === 'is_set' || v === 'is_not_set' ? { value: '' } : {}),
          })
        }
      >
        <SelectTrigger className="h-8 w-[140px] bg-background border-border">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-card border-border">
          {(spec?.operators ?? []).map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {needsValue && (
        <RuleValueInput
          spec={spec}
          rule={rule}
          tags={tags}
          onChange={(value) => onChange({ value })}
        />
      )}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        aria-label="Remove rule"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function RuleValueInput({
  spec,
  rule,
  tags,
  onChange,
}: {
  spec: RuleFieldSpec | undefined;
  rule: SegmentRule;
  tags: Tag[];
  onChange: (value: string) => void;
}) {
  if (spec?.input === 'tag') {
    return (
      <Select
        value={rule.value || ''}
        onValueChange={(v: string | null) => onChange(v ?? '')}
      >
        <SelectTrigger className="h-8 w-[170px] bg-background border-border">
          <SelectValue placeholder="Pick a tag" />
        </SelectTrigger>
        <SelectContent className="bg-card border-border">
          {tags.length === 0 ? (
            <SelectItem value="__none" disabled>
              No tags yet
            </SelectItem>
          ) : (
            tags.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    );
  }

  if (spec?.input === 'source') {
    return (
      <Select
        value={rule.value || ''}
        onValueChange={(v: string | null) => onChange(v ?? '')}
      >
        <SelectTrigger className="h-8 w-[170px] bg-background border-border">
          <SelectValue placeholder="Pick a source" />
        </SelectTrigger>
        <SelectContent className="bg-card border-border">
          {SOURCE_OPTIONS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (spec?.input === 'boolean') {
    return (
      <Select
        value={rule.value || 'true'}
        onValueChange={(v: string | null) => onChange(v ?? 'true')}
      >
        <SelectTrigger className="h-8 w-[150px] bg-background border-border">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-card border-border">
          <SelectItem value="true">present</SelectItem>
          <SelectItem value="false">missing</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  if (spec?.input === 'date') {
    return (
      <Input
        type="date"
        value={rule.value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-[170px] bg-background border-border"
      />
    );
  }

  return (
    <Input
      value={rule.value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Value"
      className="h-8 w-[190px] bg-background border-border"
    />
  );
}
