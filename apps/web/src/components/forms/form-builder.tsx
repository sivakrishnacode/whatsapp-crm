'use client';

import { useState } from 'react';
import { DndContext, closestCenter, DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical,
  Trash2,
  Plus,
  Type,
  AlignLeft,
  Mail,
  Phone,
  Hash,
  ChevronDown,
  CheckSquare,
  Circle,
  Calendar,
  Clock,
  Star,
  Heading1,
  AlignCenter,
  ToggleLeft,
  Paperclip,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { FormFieldType, PublicFormField } from './form-renderer';

// -----------------------------------------------------------------------
// Field type palette
// -----------------------------------------------------------------------

interface FieldTypeDef {
  type: FormFieldType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: string;
}

const FIELD_TYPES: FieldTypeDef[] = [
  { type: 'text', label: 'Short text', icon: Type, group: 'Input' },
  { type: 'textarea', label: 'Long text', icon: AlignLeft, group: 'Input' },
  { type: 'email', label: 'Email', icon: Mail, group: 'Input' },
  { type: 'phone', label: 'Phone', icon: Phone, group: 'Input' },
  { type: 'number', label: 'Number', icon: Hash, group: 'Input' },
  { type: 'select', label: 'Dropdown', icon: ChevronDown, group: 'Choice' },
  { type: 'radio', label: 'Radio', icon: Circle, group: 'Choice' },
  { type: 'multiselect', label: 'Checkbox list', icon: CheckSquare, group: 'Choice' },
  { type: 'date', label: 'Date', icon: Calendar, group: 'Date/Time' },
  { type: 'time', label: 'Time', icon: Clock, group: 'Date/Time' },
  { type: 'rating', label: 'Rating', icon: Star, group: 'Special' },
  { type: 'consent', label: 'Consent', icon: ToggleLeft, group: 'Special' },
  { type: 'file', label: 'File upload', icon: Paperclip, group: 'Special' },
  { type: 'heading', label: 'Heading', icon: Heading1, group: 'Layout' },
  { type: 'paragraph', label: 'Paragraph', icon: AlignCenter, group: 'Layout' },
];

// -----------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------

interface FormBuilderProps {
  fields: PublicFormField[];
  onChange: (fields: PublicFormField[]) => void;
}

// -----------------------------------------------------------------------
// Main builder
// -----------------------------------------------------------------------

export default function FormBuilder({ fields, onChange }: FormBuilderProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const addField = (type: FormFieldType) => {
    const newField: PublicFormField = {
      field_key: `field_${Math.random().toString(36).slice(2, 8)}`,
      type,
      label: FIELD_TYPES.find((f) => f.type === type)?.label ?? type,
      required: false,
      width: 'full',
      ...(type === 'select' || type === 'radio' || type === 'multiselect'
        ? { options: [{ value: 'option_1', label: 'Option 1' }] }
        : {}),
      ...(type === 'rating' ? { scale: 5 } : {}),
    };
    const next = [...fields, newField];
    onChange(next);
    setSelected(newField.field_key);
  };

  const updateField = (key: string, patch: Partial<PublicFormField>) => {
    onChange(fields.map((f) => (f.field_key === key ? { ...f, ...patch } : f)));
  };

  const removeField = (key: string) => {
    onChange(fields.filter((f) => f.field_key !== key));
    if (selected === key) setSelected(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIdx = fields.findIndex((f) => f.field_key === active.id);
      const newIdx = fields.findIndex((f) => f.field_key === over.id);
      onChange(arrayMove(fields, oldIdx, newIdx));
    }
  };

  const selectedField = fields.find((f) => f.field_key === selected);

  return (
    <div className="flex gap-4 min-h-[600px]">
      {/* Palette */}
      <div className="w-52 flex-shrink-0 rounded-lg border bg-card p-3">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Add field
        </p>
        {Object.entries(
          FIELD_TYPES.reduce<Record<string, FieldTypeDef[]>>((acc, f) => {
            (acc[f.group] ??= []).push(f);
            return acc;
          }, {}),
        ).map(([group, items]) => (
          <div key={group} className="mb-3">
            <p className="mb-1 text-xs text-muted-foreground">{group}</p>
            <div className="flex flex-col gap-1">
              {items.map((ft) => (
                <button
                  key={ft.type}
                  type="button"
                  id={`add-field-${ft.type}`}
                  onClick={() => addField(ft.type)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <ft.icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {ft.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Canvas */}
      <div className="flex-1 rounded-lg border bg-card p-4">
        {fields.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Plus className="h-8 w-8" />
            <p className="text-sm">Add a field from the left panel</p>
          </div>
        ) : (
          <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={fields.map((f) => f.field_key)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-2">
                {fields.map((field) => (
                  <SortableFieldRow
                    key={field.field_key}
                    field={field}
                    selected={selected === field.field_key}
                    onClick={() =>
                      setSelected(
                        selected === field.field_key ? null : field.field_key,
                      )
                    }
                    onRemove={() => removeField(field.field_key)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Inspector */}
      {selectedField && (
        <div className="w-64 flex-shrink-0 rounded-lg border bg-card p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Field settings
          </p>
          <FieldInspector
            field={selectedField}
            onChange={(patch) => updateField(selectedField.field_key, patch)}
          />
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Sortable field row
// -----------------------------------------------------------------------

function SortableFieldRow({
  field,
  selected,
  onClick,
  onRemove,
}: {
  field: PublicFormField;
  selected: boolean;
  onClick: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: field.field_key });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-2 rounded-md border p-3 cursor-pointer transition-colors',
        selected ? 'border-primary/60 bg-primary/5' : 'hover:border-muted-foreground/30',
        isDragging && 'opacity-50',
      )}
      onClick={onClick}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none text-muted-foreground opacity-0 group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{field.label}</span>
        <div className="flex items-center gap-1">
          <Badge variant="outline" className="text-xs py-0">
            {field.type}
          </Badge>
          {field.required && (
            <span className="text-xs text-destructive">required</span>
          )}
        </div>
      </div>

      <button
        type="button"
        id={`remove-field-${field.field_key}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------
// Field inspector (right panel)
// -----------------------------------------------------------------------

function FieldInspector({
  field,
  onChange,
}: {
  field: PublicFormField;
  onChange: (patch: Partial<PublicFormField>) => void;
}) {
  const isChoice =
    field.type === 'select' ||
    field.type === 'radio' ||
    field.type === 'multiselect';

  return (
    <div className="flex flex-col gap-4">
      {/* Label */}
      <div className="flex flex-col gap-1">
        <Label htmlFor="inspector-label">Label</Label>
        <Input
          id="inspector-label"
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </div>

      {/* Placeholder */}
      {!['heading', 'paragraph', 'consent', 'rating', 'file', 'date', 'time'].includes(
        field.type,
      ) && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="inspector-placeholder">Placeholder</Label>
          <Input
            id="inspector-placeholder"
            value={field.placeholder ?? ''}
            onChange={(e) => onChange({ placeholder: e.target.value })}
          />
        </div>
      )}

      {/* Help text */}
      <div className="flex flex-col gap-1">
        <Label htmlFor="inspector-help">Help text</Label>
        <Input
          id="inspector-help"
          value={field.help_text ?? ''}
          onChange={(e) => onChange({ help_text: e.target.value })}
        />
      </div>

      {/* Required */}
      {!['heading', 'paragraph'].includes(field.type) && (
        <div className="flex items-center justify-between">
          <Label htmlFor="inspector-required">Required</Label>
          <Switch
            id="inspector-required"
            checked={field.required ?? false}
            onCheckedChange={(v) => onChange({ required: v })}
          />
        </div>
      )}

      {/* Width */}
      <div className="flex flex-col gap-1">
        <Label>Width</Label>
        <div className="flex gap-2">
          {(['full', 'half'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onChange({ width: w })}
              className={cn(
                'flex-1 rounded-md border py-1 text-xs',
                field.width === w
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'hover:bg-muted',
              )}
            >
              {w === 'full' ? 'Full width' : 'Half width'}
            </button>
          ))}
        </div>
      </div>

      {/* Options for choice fields */}
      {isChoice && (
        <div className="flex flex-col gap-2">
          <Label>Options</Label>
          {field.options?.map((opt, idx) => (
            <div key={opt.value} className="flex gap-1">
              <Input
                value={opt.label}
                onChange={(e) => {
                  const opts = [...(field.options ?? [])];
                  opts[idx] = { ...opts[idx], label: e.target.value };
                  onChange({ options: opts });
                }}
                placeholder={`Option ${idx + 1}`}
                className="text-sm"
              />
              <button
                type="button"
                onClick={() => {
                  const opts = field.options?.filter((_, i) => i !== idx);
                  onChange({ options: opts });
                }}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const key = `option_${Math.random().toString(36).slice(2, 6)}`;
              const opts = [
                ...(field.options ?? []),
                { value: key, label: `Option ${(field.options?.length ?? 0) + 1}` },
              ];
              onChange({ options: opts });
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add option
          </Button>
        </div>
      )}

      {/* Rating scale */}
      {field.type === 'rating' && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="inspector-scale">Scale (stars)</Label>
          <Input
            id="inspector-scale"
            type="number"
            min={3}
            max={10}
            value={field.scale ?? 5}
            onChange={(e) => onChange({ scale: Number(e.target.value) })}
          />
        </div>
      )}
    </div>
  );
}
