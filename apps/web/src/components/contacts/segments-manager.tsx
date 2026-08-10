'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import type {
  ContactSegmentWithCount,
  CustomField,
  SegmentFilter,
  SegmentKind,
  Tag,
} from '@/types';
import {
  createSegment,
  deleteSegment,
  listSegments,
  updateSegment,
} from '@/lib/segments/api';
import { completeRules, describeRule, ruleFields } from '@/lib/segments/rules';
import { SegmentRuleEditor } from './segment-rule-editor';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Filter,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';

const SEGMENT_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#64748b',
];

interface SegmentsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after any create/update/delete so the caller can refetch. */
  onChanged?: () => void;
}

/**
 * Create and maintain the workspace's segments.
 *
 * Two kinds, and the choice is permanent: a STATIC segment is a list you
 * put people on (from here, the contacts table, an automation, a flow,
 * an import or the API), a DYNAMIC one is a saved filter that recomputes
 * itself. `kind` cannot be edited afterwards — flipping a static segment
 * to dynamic would orphan its members behind a filter that does not
 * describe them, and flipping the other way would invent a membership
 * list nobody chose.
 */
export function SegmentsManager({
  open,
  onOpenChange,
  onChanged,
}: SegmentsManagerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">Segments</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Named audiences you can broadcast to, filter by, and drop people
            into from automations and flows.
          </DialogDescription>
        </DialogHeader>
        <SegmentsPanel onChanged={onChanged} />
      </DialogContent>
    </Dialog>
  );
}

export function SegmentsPanel({ onChanged }: { onChanged?: () => void }) {
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [segments, setSegments] = useState<ContactSegmentWithCount[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [rows, tagRes, fieldRes] = await Promise.all([
        listSegments(supabase, accountId),
        supabase.from('tags').select('*').order('name'),
        supabase.from('custom_fields').select('*').order('field_name'),
      ]);
      setSegments(rows);
      setTags((tagRes.data as Tag[] | null) ?? []);
      setCustomFields((fieldRes.data as CustomField[] | null) ?? []);
    } catch {
      toast.error('Failed to load segments');
    }
    setLoading(false);
  }, [supabase, accountId]);

  // Setters run after the awaits inside fetchAll, not synchronously in
  // the effect body, so the set-state-in-effect rule doesn't apply.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [fetchAll]);

  async function handleDelete(id: string, name: string) {
    if (
      !window.confirm(
        `Delete the segment "${name}"? The contacts in it are not deleted.`,
      )
    ) {
      return;
    }
    setBusyId(id);
    try {
      await deleteSegment(supabase, id);
      toast.success('Segment deleted');
      await fetchAll();
      onChanged?.();
    } catch {
      toast.error('Failed to delete segment');
    }
    setBusyId(null);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
        {segments.length === 0 && !creating && (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            No segments yet.
          </p>
        )}

        {segments.map((segment) =>
          editingId === segment.id ? (
            <SegmentForm
              key={segment.id}
              initial={segment}
              tags={tags}
              customFields={customFields}
              onCancel={() => setEditingId(null)}
              onSave={async (values) => {
                await updateSegment(supabase, segment.id, {
                  name: values.name,
                  description: values.description,
                  color: values.color,
                  ...(segment.kind === 'dynamic'
                    ? { filter: values.filter }
                    : {}),
                });
                setEditingId(null);
                await fetchAll();
                onChanged?.();
                toast.success('Segment updated');
              }}
            />
          ) : (
            <SegmentRow
              key={segment.id}
              segment={segment}
              tags={tags}
              customFields={customFields}
              busy={busyId === segment.id}
              onEdit={() => setEditingId(segment.id)}
              onDelete={() => handleDelete(segment.id, segment.name)}
            />
          ),
        )}
      </div>

      {creating ? (
        <SegmentForm
          tags={tags}
          customFields={customFields}
          onCancel={() => setCreating(false)}
          onSave={async (values) => {
            if (!accountId || !user) return;
            await createSegment(supabase, {
              accountId,
              userId: user.id,
              name: values.name,
              description: values.description,
              color: values.color,
              kind: values.kind,
              filter: values.filter,
            });
            setCreating(false);
            await fetchAll();
            onChanged?.();
            toast.success('Segment created');
          }}
        />
      ) : (
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New segment
        </Button>
      )}
    </div>
  );
}

function SegmentRow({
  segment,
  tags,
  customFields,
  busy,
  onEdit,
  onDelete,
}: {
  segment: ContactSegmentWithCount;
  tags: Tag[];
  customFields: CustomField[];
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const fields = ruleFields(customFields);
  const rules = completeRules(segment.filter);
  const summary =
    segment.kind === 'dynamic'
      ? rules.length === 0
        ? 'No usable rules — matches nobody'
        : rules
            .map((r) =>
              describeRule(r, fields, (id) => tags.find((t) => t.id === id)?.name),
            )
            .join(
              (segment.filter?.match ?? 'all') === 'any' ? '  ·  or  ' : '  ·  and  ',
            )
      : segment.description || 'Contacts you add by hand';

  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-muted/10 px-3 py-2.5">
      <span
        className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: segment.color }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{segment.name}</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {segment.kind === 'dynamic' ? (
              <>
                <Filter className="h-2.5 w-2.5" /> Filter
              </>
            ) : (
              <>
                <Layers className="h-2.5 w-2.5" /> List
              </>
            )}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Users className="h-3 w-3" />
            {segment.member_count}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{summary}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0 text-muted-foreground"
        onClick={onEdit}
        aria-label={`Edit ${segment.name}`}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Delete ${segment.name}`}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

interface SegmentFormValues {
  name: string;
  description: string;
  color: string;
  kind: SegmentKind;
  filter: SegmentFilter;
}

function SegmentForm({
  initial,
  tags,
  customFields,
  onCancel,
  onSave,
}: {
  initial?: ContactSegmentWithCount;
  tags: Tag[];
  customFields: CustomField[];
  onCancel: () => void;
  onSave: (values: SegmentFormValues) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState(initial?.color ?? SEGMENT_COLORS[0]);
  const [kind, setKind] = useState<SegmentKind>(initial?.kind ?? 'static');
  const [filter, setFilter] = useState<SegmentFilter>(
    initial?.filter ?? { match: 'all', rules: [] },
  );
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(initial);

  async function handleSave() {
    if (!name.trim()) {
      toast.error('Give the segment a name');
      return;
    }
    setSaving(true);
    try {
      await onSave({ name, description, color, kind, filter });
    } catch (err) {
      // The unique index on (account_id, lower(name)) is the usual
      // cause, and "already exists" is more use than the raw code.
      const message =
        (err as { code?: string })?.code === '23505'
          ? `A segment named "${name.trim()}" already exists`
          : 'Failed to save segment';
      toast.error(message);
    }
    setSaving(false);
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="segment-name">Name</Label>
          <Input
            id="segment-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="March webinar attendees"
            maxLength={80}
            className="bg-background border-border"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Colour</Label>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {SEGMENT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Colour ${c}`}
                className={`h-6 w-6 rounded-full transition ${
                  color === c ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground' : ''
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="segment-description">Description</Label>
        <Textarea
          id="segment-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What this audience is for"
          className="bg-background border-border"
        />
      </div>

      {!isEdit && (
        <div className="space-y-1.5">
          <Label>Type</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            <KindCard
              active={kind === 'static'}
              onClick={() => setKind('static')}
              icon={<Layers className="h-4 w-4" />}
              title="List"
              body="You choose who is in it — from contacts, automations, flows or an import."
            />
            <KindCard
              active={kind === 'dynamic'}
              onClick={() => setKind('dynamic')}
              icon={<Filter className="h-4 w-4" />}
              title="Filter"
              body="Membership is worked out from rules, so it is never out of date."
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            This cannot be changed later — a filter has no membership list to
            keep, and a list has no rules to apply.
          </p>
        </div>
      )}

      {kind === 'dynamic' && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <Label>Rules</Label>
          <SegmentRuleEditor
            filter={filter}
            onChange={setFilter}
            tags={tags}
            customFields={customFields}
          />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {isEdit ? 'Save changes' : 'Create segment'}
        </Button>
      </div>
    </div>
  );
}

function KindCard({
  active,
  onClick,
  icon,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border p-2.5 text-left transition ${
        active
          ? 'border-primary bg-primary/5'
          : 'border-border bg-background hover:border-muted-foreground/40'
      }`}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {title}
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">{body}</span>
    </button>
  );
}
