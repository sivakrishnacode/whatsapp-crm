'use client';

/**
 * The form builder: palette | live canvas | inspector.
 *
 * THE CANVAS IS THE REAL FORM
 *   Field previews are rendered by `FieldInput` — the very component the
 *   hosted page, the embed and the widget use — inside a non-interactive
 *   shell. A builder that draws its own approximation of a field drifts
 *   from the published form silently, and the first person to notice is a
 *   customer looking at a live page. Half-width fields therefore sit side
 *   by side here exactly as they will publicly, because it is the same
 *   flex-wrap container doing it.
 *
 * ONE DndContext, TWO KINDS OF DRAG
 *   Dragging from the palette INSERTS at the drop position; dragging a
 *   field on the canvas MOVES it. Both end in `handleDragEnd`, told apart
 *   by `active.data.current.kind`. Appending on click stays available
 *   because dragging is the slower way to do the common thing.
 */

import { useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Copy,
  CornerDownRight,
  EyeOff,
  GripVertical,
  Palette as PaletteIcon,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  FIELD_GROUP_ORDER,
  FIELD_TYPES,
  fieldTypeDef,
  makeFieldKey,
  type FieldTypeDef,
  type FormBuilderField,
} from '@/lib/forms/field-types';
import { splitIntoPages } from '@/lib/forms/visibility';
import type { FormTheme } from '@/lib/forms/theme';
import type { FormFieldType } from './form-renderer';
import FormRenderer, { ACCENT_BUTTON, FieldInput } from './form-renderer';
import FormFieldInspector from './form-field-inspector';
import FormDesignControls from './form-design-controls';
import FormSurface from './form-surface';

interface FormBuilderProps {
  fields: FormBuilderField[];
  onChange: (fields: FormBuilderField[]) => void;
  /** Resolved appearance. The canvas paints what the visitor will see. */
  theme: FormTheme;
  onThemeChange: (next: FormTheme) => void;
  /** For the preview's page chrome — the title, blurb and branding. */
  formName: string;
  description: string | null;
  submitLabel: string;
}

/**
 * Builder, design and preview in ONE surface.
 *
 * They were three tabs, and the split was never real: the canvas already
 * renders the actual `FieldInput`, so it was a preview; the Appearance tab
 * carried a second preview of the same form beside it; and the Preview tab
 * was a third. Three views of one thing, each slightly behind the others,
 * and two Save buttons between them.
 *
 * Now: the canvas is the preview, `Design` is the other half of the
 * inspector, and `Preview` is a MODE that swaps the editing chrome for a
 * working form on its real page background. One Save, in the header,
 * writes fields and theme together.
 */
export default function FormBuilder({
  fields,
  onChange,
  theme,
  onThemeChange,
  formName,
  description,
  submitLabel,
}: FormBuilderProps) {
  /**
   * Whether the form's own inputs accept typing.
   *
   * NOT a second view — the canvas is one canvas, on its real page
   * background, either way. This is the one thing that genuinely cannot
   * be both at once: a click on a text box either selects the field to
   * edit it or puts a cursor in it. So it is a switch on the canvas
   * rather than a mode that reshuffles the screen, and the palette and
   * inspector stay exactly where they were.
   */
  const [live, setLive] = useState(false);
  const [inspector, setInspector] = useState<'field' | 'design'>('field');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState<
    { kind: 'palette'; def: FieldTypeDef } | { kind: 'field'; key: string } | null
  >(null);

  // Distance before a drag starts, so clicking a field to select it does
  // not register as a two-pixel drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const takenKeys = useMemo(
    () => new Set(fields.map((f) => f.field_key)),
    [fields],
  );

  const buildField = (type: FormFieldType): FormBuilderField => {
    const def = fieldTypeDef(type);
    const label = def?.label ?? type;
    return {
      field_key: makeFieldKey(label, takenKeys),
      type,
      label: type === 'page_break' ? 'Page break' : label,
      required: false,
      width: 'full',
      ...(def?.choice
        ? {
            options: [
              { value: 'option_1', label: 'Option 1' },
              { value: 'option_2', label: 'Option 2' },
            ],
          }
        : {}),
      ...(type === 'rating' ? { scale: 5 } : {}),
    };
  };

  const insertAt = (type: FormFieldType, index: number) => {
    const created = buildField(type);
    const next = [...fields];
    next.splice(index, 0, created);
    onChange(next);
    setSelected(created.field_key);
  };

  const updateField = (key: string, patch: Partial<FormBuilderField>) => {
    onChange(
      fields.map((f) => (f.field_key === key ? { ...f, ...patch } : f)),
    );
  };

  const removeField = (key: string) => {
    // Any rule pointing at the removed field goes with it. Left behind, it
    // would name a field that no longer exists, which the server refuses
    // at save time — with the error on a field the author did not touch.
    onChange(
      fields
        .filter((f) => f.field_key !== key)
        .map((f) =>
          f.visible_when?.field_key === key
            ? { ...f, visible_when: undefined }
            : f,
        ),
    );
    if (selected === key) setSelected(null);
  };

  const duplicateField = (key: string) => {
    const idx = fields.findIndex((f) => f.field_key === key);
    if (idx < 0) return;
    const source = fields[idx];
    const copy: FormBuilderField = {
      ...source,
      field_key: makeFieldKey(source.label || source.type, takenKeys),
      // The copy keeps its own answers, so a rule that pointed at the
      // original still points at the original — carrying it over would
      // make two fields appear and disappear together for no stated
      // reason.
      visible_when: source.visible_when,
    };
    const next = [...fields];
    next.splice(idx + 1, 0, copy);
    onChange(next);
    setSelected(copy.field_key);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as
      | { kind: 'palette'; def: FieldTypeDef }
      | { kind: 'field' }
      | undefined;
    if (data?.kind === 'palette') setDragging({ kind: 'palette', def: data.def });
    else setDragging({ kind: 'field', key: String(event.active.id) });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;

    const data = active.data.current as
      | { kind: 'palette'; def: FieldTypeDef }
      | { kind: 'field' }
      | undefined;

    // Where the pointer landed: on a field (insert before it) or on the
    // canvas itself (append).
    const overIndex =
      over.id === CANVAS_DROP_ID
        ? fields.length
        : fields.findIndex((f) => f.field_key === over.id);

    if (data?.kind === 'palette') {
      insertAt(data.def.type, overIndex < 0 ? fields.length : overIndex);
      return;
    }

    if (active.id === over.id || overIndex < 0) return;
    const from = fields.findIndex((f) => f.field_key === active.id);
    if (from < 0) return;
    onChange(arrayMove(fields, from, overIndex));
  };

  const selectedIndex = fields.findIndex((f) => f.field_key === selected);
  const selectedField = selectedIndex >= 0 ? fields[selectedIndex] : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex h-full min-h-0 gap-4">
        <Palette
          query={query}
          onQueryChange={setQuery}
          onAdd={(type) => insertAt(type, fields.length)}
        />

        <Canvas
          fields={fields}
          theme={theme}
          formName={formName}
          description={description}
          submitLabel={submitLabel}
          live={live}
          onLiveChange={setLive}
          selected={selected}
          onSelect={setSelected}
          onRemove={removeField}
          onDuplicate={duplicateField}
        />

        <aside className="hidden w-80 shrink-0 flex-col overflow-hidden rounded-xl border bg-card xl:flex">
          {/* Field and Design are two halves of one inspector rather than
              two tabs of the editor: both describe the thing on the
              canvas, and switching between them should not move you off
              it. */}
          <div className="flex flex-none gap-1 border-b p-2">
            <InspectorTab
              active={inspector === 'field'}
              onClick={() => setInspector('field')}
              icon={SlidersHorizontal}
              label="Field"
            />
            <InspectorTab
              active={inspector === 'design'}
              onClick={() => setInspector('design')}
              icon={PaletteIcon}
              label="Design"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {inspector === 'design' ? (
              <FormDesignControls theme={theme} onChange={onThemeChange} />
            ) : selectedField ? (
              <FormFieldInspector
                key={selectedField.field_key}
                field={selectedField}
                precedingFields={fields.slice(0, selectedIndex)}
                onChange={(patch) =>
                  updateField(selectedField.field_key, patch)
                }
              />
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Select a field to change its label, make it required, save it
                to a contact, or show it only when an earlier answer matches.{' '}
                <strong>Design</strong> sets the colours and layout of the
                whole form.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* Follows the cursor. Without it a palette drag looks like nothing
          is happening until the drop lands. */}
      <DragOverlay dropAnimation={null}>
        {dragging?.kind === 'palette' ? (
          <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-card px-3 py-2 text-sm shadow-lg">
            <dragging.def.icon className="h-4 w-4 text-primary" />
            {dragging.def.label}
          </div>
        ) : dragging?.kind === 'field' ? (
          <div className="rounded-lg border border-primary/40 bg-card px-3 py-2 text-sm shadow-lg">
            {fields.find((f) => f.field_key === dragging.key)?.label ??
              'Field'}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// -----------------------------------------------------------------------
// Toolbar / preview
// -----------------------------------------------------------------------

function InspectorTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

// -----------------------------------------------------------------------
// Palette
// -----------------------------------------------------------------------

function Palette({
  query,
  onQueryChange,
  onAdd,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  onAdd: (type: FormFieldType) => void;
}) {
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? FIELD_TYPES.filter(
          (f) =>
            f.label.toLowerCase().includes(q) ||
            f.type.includes(q) ||
            f.hint.toLowerCase().includes(q),
        )
      : FIELD_TYPES;

    return FIELD_GROUP_ORDER.map((group) => ({
      group,
      items: matches.filter((f) => f.group === group),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="border-b p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="field-search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search fields"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {groups.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">
            No field type matches &ldquo;{query}&rdquo;.
          </p>
        ) : (
          groups.map(({ group, items }) => (
            <div key={group} className="mb-4 last:mb-0">
              <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group}
              </p>
              <div className="flex flex-col gap-0.5">
                {items.map((def) => (
                  <PaletteItem key={def.type} def={def} onAdd={onAdd} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <p className="border-t px-3 py-2 text-[10px] leading-relaxed text-muted-foreground/70">
        Drag onto the form, or click to add at the end.
      </p>
    </aside>
  );
}

function PaletteItem({
  def,
  onAdd,
}: {
  def: FieldTypeDef;
  onAdd: (type: FormFieldType) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${def.type}`,
    data: { kind: 'palette', def },
  });

  // dnd-kit swallows the click that ends a drag, but a drag that never
  // moved still fires one. Tracking the press position keeps "click to
  // append" working without it firing after a real drag.
  const pressed = useRef<{ x: number; y: number } | null>(null);

  return (
    <button
      ref={setNodeRef}
      type="button"
      id={`add-field-${def.type}`}
      title={def.hint}
      {...attributes}
      {...listeners}
      onPointerDown={(e) => {
        pressed.current = { x: e.clientX, y: e.clientY };
        listeners?.onPointerDown?.(e);
      }}
      onClick={(e) => {
        const start = pressed.current;
        pressed.current = null;
        if (
          start &&
          Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5
        )
          return;
        onAdd(def.type);
      }}
      className={cn(
        'flex w-full cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted active:cursor-grabbing',
        isDragging && 'opacity-40',
      )}
    >
      <def.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{def.label}</span>
    </button>
  );
}

// -----------------------------------------------------------------------
// Canvas
// -----------------------------------------------------------------------

const CANVAS_DROP_ID = '__canvas__';

function Canvas({
  fields,
  theme,
  formName,
  description,
  submitLabel,
  live,
  onLiveChange,
  selected,
  onSelect,
  onRemove,
  onDuplicate,
}: {
  fields: FormBuilderField[];
  theme: FormTheme;
  formName: string;
  description: string | null;
  submitLabel: string;
  live: boolean;
  onLiveChange: (v: boolean) => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onRemove: (key: string) => void;
  onDuplicate: (key: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: CANVAS_DROP_ID });

  // Empty pages are dropped for the same reason the renderer drops them:
  // a break with nothing after it produces no step, and counting one here
  // would promise a "Step 3 of 3" that never appears.
  const pageCount = Math.max(
    splitIntoPages(fields).filter((p) => p.length > 0).length,
    1,
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-muted/20">
      <div className="flex flex-none items-center gap-3 border-b bg-card/60 px-4 py-2">
        <p className="text-[11px] text-muted-foreground">
          {live
            ? 'Typing in the form. Submitting is disabled.'
            : 'Click a field to edit it. Drag to reorder.'}
        </p>
        <label className="ml-auto flex cursor-pointer items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            Try it
          </span>
          <Switch
            id="builder-try-it"
            checked={live}
            onCheckedChange={onLiveChange}
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/*
          The page chrome is here in BOTH states, not just a preview mode.
          The canvas is the form on its real background — header banner,
          accent, branding — so there is nothing to switch to in order to
          "see how it looks", and the only thing `live` changes is whether
          the inputs take a cursor.
        */}
        <FormSurface
          theme={theme}
          name={formName}
          description={description}
          preview
          booking={fields.some((f) => f.type === 'appointment_slot')}
        >
          {live ? (
            <FormRenderer
              // Remounted when the field list changes so a rule or a new
              // field is reflected immediately rather than after the
              // renderer's own state catches up.
              key={fields.map((f) => f.field_key).join('|')}
              form={{
                id: 'preview',
                name: formName,
                description,
                slug: 'preview',
                kind: 'form',
                fields,
                settings: { submit_label: submitLabel, honeypot: false },
              }}
              preview
            />
          ) : (
            <div
              ref={setNodeRef}
              onClick={(e) => {
                if (e.target === e.currentTarget) onSelect(null);
              }}
              className={cn(
                'min-h-[16rem] rounded-lg transition-colors',
                isOver && 'bg-primary/5 outline-2 outline-dashed outline-primary/40',
              )}
            >
              {fields.length === 0 ? (
                <EmptyCanvas />
              ) : (
                <SortableContext
                  items={fields.map((f) => f.field_key)}
                  strategy={verticalListSortingStrategy}
                >
                  {/* gap-6 and the 0.75rem half-width below are the
                      renderer's own numbers, not approximations of them.
                      They have to be identical or a half-width pair sits
                      differently here than it does publicly. */}
                  <div className="flex flex-wrap gap-6">
                    {fields.map((field, idx) => (
                      <CanvasField
                        key={field.field_key}
                        field={field}
                        stepNumber={
                          field.type === 'page_break'
                            ? fields
                                .slice(0, idx)
                                .filter((f) => f.type === 'page_break').length +
                              2
                            : undefined
                        }
                        totalSteps={pageCount}
                        selected={selected === field.field_key}
                        onSelect={() => onSelect(field.field_key)}
                        onRemove={() => onRemove(field.field_key)}
                        onDuplicate={() => onDuplicate(field.field_key)}
                      />
                    ))}

                    {/* The submit button is part of the form, so the
                        canvas shows it. Inert, and not selectable — its
                        label lives on the Settings tab. */}
                    <div className="w-full pt-2">
                      <button
                        type="button"
                        disabled
                        style={ACCENT_BUTTON}
                        className="w-full px-8 py-2.5 font-medium shadow-md sm:w-auto"
                      >
                        {submitLabel}
                      </button>
                    </div>
                  </div>
                </SortableContext>
              )}
            </div>
          )}
        </FormSurface>
      </div>
    </div>
  );
}

function EmptyCanvas() {
  return (
    <div className="flex h-72 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-background/50 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Plus className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">Drag a field here</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Or click one in the palette. What you build here is exactly what
        your visitors will see.
      </p>
    </div>
  );
}

function CanvasField({
  field,
  stepNumber,
  totalSteps,
  selected,
  onSelect,
  onRemove,
  onDuplicate,
}: {
  field: FormBuilderField;
  stepNumber?: number;
  totalSteps: number;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.field_key, data: { kind: 'field' } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isHalf = field.width === 'half' && field.type !== 'page_break';

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      /*
       * Geometry is the RENDERER'S, exactly.
       *
       * This wrapper used to add `p-2` and a border, and set its own
       * half-width from a different gap — so a half-width field was
       * narrower here than in public, and (worse) the width was applied
       * TWICE: this element took 50%, then the FieldInput inside took 50%
       * of that. Half-width fields were rendering at about a quarter.
       *
       * Now: no padding, no border, the renderer's own `0.75rem` figure,
       * and the selection indicator is an OUTLINE — outlines are painted
       * outside the box and take no layout space, so the field measures
       * the same selected, hovered or neither.
       */
      className={cn(
        'group relative cursor-pointer rounded-lg outline-offset-4 transition-[outline-color]',
        isHalf ? 'w-full sm:w-[calc(50%-0.75rem)]' : 'w-full',
        selected
          ? 'outline-2 outline-primary/60'
          : 'outline-2 outline-transparent hover:outline-border',
        isDragging && 'opacity-40',
      )}
    >
      {/* Hover/selected chrome. Absolutely positioned so it never changes
          the field's own layout — the canvas has to measure like the real
          form or half-width pairs would not line up. */}
      <div
        className={cn(
          'absolute -top-2.5 right-2 z-10 flex items-center gap-0.5 rounded-md border bg-card px-1 py-0.5 shadow-sm transition-opacity',
          selected
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${field.label}`}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={`Duplicate ${field.label}`}
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          id={`remove-field-${field.field_key}`}
          aria-label={`Remove ${field.label}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Floated, not inline: a badge in the flow would push the field
          down and make the canvas taller than the published form. */}
      <div
        className={cn(
          'absolute -top-2.5 left-2 z-10 transition-opacity',
          selected ? 'opacity-100' : 'opacity-90',
        )}
      >
        <FieldBadges field={field} />
      </div>

      {field.type === 'page_break' ? (
        <PageBreakPreview step={stepNumber ?? 2} total={totalSteps} />
      ) : field.type === 'hidden' ? (
        <HiddenPreview field={field} />
      ) : (
        /* The real renderer, made inert. `pointer-events-none` is what
           stops a click landing in the input instead of selecting the
           field, and `inert` keeps the preview out of the tab order — the
           builder's own controls are the interactive ones. */
        <div className="pointer-events-none select-none" inert>
          <FieldInput
            // `width: 'full'` because THIS wrapper already carries the
            // half-width. Passing the field's own width made FieldInput
            // take 50% of a box that was already 50%.
            field={{ ...field, width: 'full' }}
            value={undefined}
            error={undefined}
            onChange={() => {}}
          />
        </div>
      )}
    </div>
  );
}

/** Rule and mapping markers — the two settings with invisible effects. */
function FieldBadges({ field }: { field: FormBuilderField }) {
  const badges: string[] = [];
  if (field.visible_when?.field_key) badges.push('conditional');
  if (field.mapping) badges.push(`→ ${mappingLabel(field.mapping)}`);
  if (badges.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {badges.map((b) => (
        <span
          key={b}
          className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-violet"
        >
          {b === 'conditional' && <CornerDownRight className="h-2.5 w-2.5" />}
          {b}
        </span>
      ))}
    </div>
  );
}

function mappingLabel(mapping: string): string {
  if (mapping.startsWith('custom:')) return 'custom field';
  return mapping;
}

function PageBreakPreview({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 border-t border-dashed border-primary/40" />
      <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
        Step {step} of {total}
      </span>
      <div className="h-px flex-1 border-t border-dashed border-primary/40" />
    </div>
  );
}

function HiddenPreview({ field }: { field: FormBuilderField }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5">
      <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{field.label}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          Hidden — filled from <code>?{field.field_key}=</code> in the URL
        </p>
      </div>
    </div>
  );
}
