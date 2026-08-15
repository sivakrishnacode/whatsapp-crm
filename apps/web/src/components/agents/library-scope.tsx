'use client';

import { useState } from 'react';
import { Library, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * ============================================================
 * "Which of the shared library may THIS agent use?"
 *
 * Knowledge documents and custom actions belong to the workspace, not to
 * an agent: one upload, one embedding cost, one reindex. Each agent then
 * selects from that library — which is why this control appears twice,
 * once on Knowledge and once on Actions, and behaves identically both
 * times.
 *
 * ⚠️ "Everything" and "only these" are stored as two different things —
 * a boolean plus a link table — rather than as an empty selection. If an
 * empty list meant "everything", then unticking the last document would
 * silently re-grant the whole library, which is the opposite of what the
 * person clicking it just asked for. So an empty selection here means
 * exactly what it looks like: this agent reads nothing.
 * ============================================================
 */
export function LibraryScope({
  noun,
  usesAll,
  selectedCount,
  totalCount,
  canEdit,
  saving,
  onUseAll,
  onUseSelected,
}: {
  /** "documents" / "actions" — used in the sentences below. */
  noun: string;
  usesAll: boolean;
  selectedCount: number;
  totalCount: number;
  canEdit: boolean;
  saving: boolean;
  onUseAll: () => void;
  /** Switch to "only these", starting from the current selection. */
  onUseSelected: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Library className="size-4 text-primary" />
          {usesAll
            ? `This agent uses every ${noun.replace(/s$/, '')} in the workspace`
            : `This agent uses ${selectedCount} of ${totalCount} ${noun}`}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {usesAll
            ? `Anything added later is available to it automatically. Your other agents share the same library.`
            : selectedCount === 0
              ? `Nothing is selected, so this agent answers without any ${noun} at all.`
              : `New ${noun} are NOT added automatically — tick them here when you add one.`}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border p-0.5">
        <ScopeButton
          active={usesAll}
          disabled={!canEdit || saving}
          onClick={onUseAll}
          label="Everything"
        />
        <ScopeButton
          active={!usesAll}
          disabled={!canEdit || saving}
          onClick={onUseSelected}
          label="Only these"
        />
        {saving && <Loader2 className="mx-1 size-3.5 animate-spin text-muted-foreground" />}
      </div>
    </div>
  );
}

function ScopeButton({
  active,
  disabled,
  onClick,
  label,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60',
        active
          ? 'bg-primary/10 text-foreground'
          : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  );
}

/**
 * The tick on one row, plus the "save the selection" bar.
 *
 * Selection is saved EXPLICITLY rather than on each click: ticking six
 * documents would otherwise be six writes and six toasts, and a
 * half-applied selection is a live change to what an agent may read.
 */
export function useLibrarySelection(initial: string[]) {
  const [selected, setSelected] = useState<string[]>(initial);
  const [syncedFrom, setSyncedFrom] = useState(initial);
  const [dirty, setDirty] = useState(false);

  // Adopt a fresh server list unless the user is mid-edit — the same
  // pattern the persona form uses. Compared by value: the array is
  // rebuilt on every fetch, so an identity check would reset the form on
  // every poll.
  const key = initial.join(',');
  const syncedKey = syncedFrom.join(',');
  if (key !== syncedKey) {
    setSyncedFrom(initial);
    if (!dirty) setSelected(initial);
  }

  const toggle = (id: string) => {
    setDirty(true);
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  return {
    selected,
    dirty,
    toggle,
    reset: () => {
      setSelected(initial);
      setDirty(false);
    },
    clean: () => setDirty(false),
  };
}

export function SelectionBar({
  count,
  noun,
  saving,
  onCancel,
  onSave,
}: {
  count: number;
  noun: string;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="sticky bottom-2 z-10 flex items-center justify-between gap-3 rounded-xl border border-primary/40 bg-card p-3 shadow-lg">
      <p className="text-sm text-foreground">
        {count} {noun} selected
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save selection
        </Button>
      </div>
    </div>
  );
}
