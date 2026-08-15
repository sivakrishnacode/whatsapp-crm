'use client';

/**
 * The selected field's settings — the builder's right-hand panel.
 *
 * Which controls appear is derived from the field type's entry in
 * `lib/forms/field-types.ts`, not from branching on the type here, so a
 * field can never be offered a setting the renderer will ignore.
 */

import { useEffect, useMemo, useState } from 'react';
import { GripVertical, Plus, Trash2, Info } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { fieldTypeDef, type FormBuilderField } from '@/lib/forms/field-types';
import {
  CONDITION_OPERATOR_LABELS,
  FIELD_CONDITION_OPERATORS,
  VALUELESS_OPERATORS,
  type FieldConditionOperator,
} from '@/lib/forms/visibility';

interface CustomField {
  id: string;
  field_name: string;
}

export default function FormFieldInspector({
  field,
  /** Every field ABOVE this one — the only legal condition sources. */
  precedingFields,
  onChange,
}: {
  field: FormBuilderField;
  precedingFields: FormBuilderField[];
  onChange: (patch: Partial<FormBuilderField>) => void;
}) {
  const def = fieldTypeDef(field.type);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);

  // Contact mapping offers custom fields by name, so the list has to be
  // real. Read straight from Supabase like the rest of the contacts UI —
  // RLS scopes it to the workspace.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('custom_fields')
        .select('id, field_name')
        .order('field_name');
      if (!cancelled && data) setCustomFields(data as CustomField[]);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!def) return null;

  const isPresentational = Boolean(def.presentational);

  return (
    <div className="flex flex-col gap-5">
      {/* ---------------- Basics ---------------- */}
      <Section title={field.type === 'page_break' ? 'Step' : 'Basics'}>
        {field.type === 'page_break' ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Everything after this break becomes the next step. The visitor
            gets a progress bar and must complete each step before moving
            on.
          </p>
        ) : (
          <>
            <Field label={field.type === 'paragraph' ? 'Text' : 'Label'}>
              {field.type === 'paragraph' ? (
                <Textarea
                  value={field.label}
                  rows={3}
                  onChange={(e) => onChange({ label: e.target.value })}
                />
              ) : (
                <Input
                  value={field.label}
                  onChange={(e) => onChange({ label: e.target.value })}
                />
              )}
            </Field>

            {def.placeholder && (
              <Field label="Placeholder">
                <Input
                  value={field.placeholder ?? ''}
                  placeholder="Shown while the box is empty"
                  onChange={(e) => onChange({ placeholder: e.target.value })}
                />
              </Field>
            )}

            {field.type !== 'paragraph' && (
              <Field label="Help text">
                <Input
                  value={field.help_text ?? ''}
                  placeholder="A hint under the field"
                  onChange={(e) => onChange({ help_text: e.target.value })}
                />
              </Field>
            )}
          </>
        )}

        {/* The key is what submissions are stored under, so it is shown
            (an export column nobody can find is worse) but not editable —
            changing it orphans every answer already collected. */}
        {!isPresentational && (
          <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5">
            <Info className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">
              Saved as{' '}
              <code className="font-mono text-foreground">
                {field.field_key}
              </code>
            </span>
          </div>
        )}
      </Section>

      {/* ---------------- Behaviour ---------------- */}
      {!isPresentational && (
        <Section title="Behaviour">
          {field.type !== 'consent' && field.type !== 'hidden' && (
            <Toggle
              label="Required"
              hint="Blocks submission until answered"
              checked={field.required ?? false}
              onChange={(v) => onChange({ required: v })}
            />
          )}

          {field.type === 'consent' && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Consent is always required — an unticked box is a &ldquo;no&rdquo;,
              not a missing answer, and is never recorded as consent given.
            </p>
          )}

          {field.type === 'hidden' && (
            <Field
              label="Default value"
              hint="Used when the URL has no matching ?query parameter."
            >
              <Input
                value={field.default_value ?? ''}
                onChange={(e) => onChange({ default_value: e.target.value })}
              />
            </Field>
          )}

          {def.bounds && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Minimum">
                <Input
                  type="number"
                  value={field.min ?? ''}
                  onChange={(e) =>
                    onChange({
                      min:
                        e.target.value === ''
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Maximum">
                <Input
                  type="number"
                  value={field.max ?? ''}
                  onChange={(e) =>
                    onChange({
                      max:
                        e.target.value === ''
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
          )}

          {field.type === 'rating' && (
            <Field label="Stars">
              <Input
                type="number"
                min={3}
                max={10}
                value={field.scale ?? 5}
                onChange={(e) => onChange({ scale: Number(e.target.value) })}
              />
            </Field>
          )}

          {field.type === 'file' && (
            <Field
              label="Accepted types"
              hint="Comma-separated, e.g. .pdf, .docx, image/*"
            >
              <Input
                value={(field.accept ?? []).join(', ')}
                placeholder=".pdf, .png"
                onChange={(e) =>
                  onChange({
                    accept: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
          )}
        </Section>
      )}

      {/* ---------------- Options ---------------- */}
      {def.choice && (
        <Section title="Options">
          <OptionsEditor field={field} onChange={onChange} />
        </Section>
      )}

      {/* ---------------- Layout ---------------- */}
      {field.type !== 'page_break' && (
        <Section title="Layout">
          <Field label="Width">
            <div className="flex gap-2">
              {(['full', 'half'] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => onChange({ width: w })}
                  className={cn(
                    'flex-1 rounded-md border py-1.5 text-xs transition-colors',
                    (field.width ?? 'full') === w
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:bg-muted',
                  )}
                >
                  {w === 'full' ? 'Full' : 'Half'}
                </button>
              ))}
            </div>
          </Field>
        </Section>
      )}

      {/* ---------------- Contact mapping ---------------- */}
      {def.mappable && (
        <Section
          title="Save to contact"
          hint="Where this answer lands on the contact record. Leave unmapped to keep it on the submission only."
        >
          <select
            value={field.mapping ?? ''}
            onChange={(e) =>
              onChange({ mapping: e.target.value || undefined })
            }
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Don&apos;t save to contact</option>
            <option value="name">Name</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="company">Company</option>
            {customFields.length > 0 && (
              <optgroup label="Custom fields">
                {customFields.map((cf) => (
                  <option key={cf.id} value={`custom:${cf.id}`}>
                    {cf.field_name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Section>
      )}

      {/* ---------------- Conditional logic ---------------- */}
      {field.type !== 'page_break' && (
        <Section
          title="Conditional logic"
          hint="Show this field only when an earlier answer matches."
        >
          <ConditionEditor
            field={field}
            precedingFields={precedingFields}
            onChange={onChange}
          />
        </Section>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Conditional logic
// -----------------------------------------------------------------------

function ConditionEditor({
  field,
  precedingFields,
  onChange,
}: {
  field: FormBuilderField;
  precedingFields: FormBuilderField[];
  onChange: (patch: Partial<FormBuilderField>) => void;
}) {
  // Only fields that carry an answer, and only ones ABOVE this one — the
  // server rejects a forward reference, because a field further down can
  // never be answered in time to decide anything.
  const sources = useMemo(
    () =>
      precedingFields.filter(
        (f) => !fieldTypeDef(f.type)?.presentational && f.type !== 'hidden',
      ),
    [precedingFields],
  );

  const rule = field.visible_when;

  if (sources.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Add a question above this one first — a rule can only depend on an
        answer the visitor has already given.
      </p>
    );
  }

  if (!rule) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() =>
          onChange({
            visible_when: {
              field_key: sources[sources.length - 1].field_key,
              operator: 'equals',
              value: '',
            },
          })
        }
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add a rule
      </Button>
    );
  }

  const source = sources.find((f) => f.field_key === rule.field_key);
  const needsValue = !VALUELESS_OPERATORS.includes(rule.operator);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2.5">
      <span className="text-[11px] font-medium text-muted-foreground">
        Show this field when
      </span>

      <select
        value={rule.field_key}
        onChange={(e) =>
          onChange({
            visible_when: { ...rule, field_key: e.target.value, value: '' },
          })
        }
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
      >
        {sources.map((f) => (
          <option key={f.field_key} value={f.field_key}>
            {f.label || f.field_key}
          </option>
        ))}
      </select>

      <select
        value={rule.operator}
        onChange={(e) =>
          onChange({
            visible_when: {
              ...rule,
              operator: e.target.value as FieldConditionOperator,
            },
          })
        }
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
      >
        {FIELD_CONDITION_OPERATORS.map((op) => (
          <option key={op} value={op}>
            {CONDITION_OPERATOR_LABELS[op]}
          </option>
        ))}
      </select>

      {needsValue &&
        // A choice field's answers are a known list, so offer them rather
        // than inviting someone to type a value that can never match.
        (source?.options?.length ? (
          <select
            value={rule.value ?? ''}
            onChange={(e) =>
              onChange({ visible_when: { ...rule, value: e.target.value } })
            }
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">Choose a value…</option>
            {source.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <Input
            value={rule.value ?? ''}
            placeholder="Value"
            className="h-8 text-xs"
            onChange={(e) =>
              onChange({ visible_when: { ...rule, value: e.target.value } })
            }
          />
        ))}

      <button
        type="button"
        onClick={() => onChange({ visible_when: undefined })}
        className="self-start text-[11px] text-muted-foreground hover:text-destructive"
      >
        Remove rule
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------

function OptionsEditor({
  field,
  onChange,
}: {
  field: FormBuilderField;
  onChange: (patch: Partial<FormBuilderField>) => void;
}) {
  const options = field.options ?? [];

  const setLabel = (idx: number, label: string) => {
    const next = [...options];
    // The VALUE is left alone. It is what lands in submissions.data and
    // what any conditional rule points at, so rewording a label must not
    // silently repoint either.
    next[idx] = { ...next[idx], label };
    onChange({ options: next });
  };

  return (
    <div className="flex flex-col gap-1.5">
      {options.map((opt, idx) => (
        <div key={opt.value} className="flex items-center gap-1">
          <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
          <Input
            value={opt.label}
            className="h-8 text-xs"
            placeholder={`Option ${idx + 1}`}
            onChange={(e) => setLabel(idx, e.target.value)}
          />
          <button
            type="button"
            aria-label={`Remove option ${idx + 1}`}
            onClick={() =>
              onChange({ options: options.filter((_, i) => i !== idx) })
            }
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-1"
        onClick={() => {
          const n = options.length + 1;
          onChange({
            options: [
              ...options,
              {
                value: `option_${Math.random().toString(36).slice(2, 7)}`,
                label: `Option ${n}`,
              },
            ],
          });
        }}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add option
      </Button>
    </div>
  );
}

// -----------------------------------------------------------------------
// Small layout helpers
// -----------------------------------------------------------------------

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {hint && (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
            {hint}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && (
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">
          {hint}
        </p>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex flex-col">
        <Label className="text-xs font-medium">{label}</Label>
        {hint && (
          <span className="text-[11px] text-muted-foreground/80">{hint}</span>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
