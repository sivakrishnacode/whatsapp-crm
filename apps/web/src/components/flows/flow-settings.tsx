'use client';

/**
 * Flow-level settings: the trigger and the entry node.
 *
 * WHY THIS IS ITS OWN MODULE
 *   These two panels used to live inside `flow-builder.tsx`, which made
 *   them LIST-ONLY — a canvas user had no way to set a keyword without
 *   switching views, and the canvas is now the default. The docked
 *   inspector renders them whenever no node is selected, so "what starts
 *   this flow" is always one click away in either view.
 *
 * Both views mount the same components, so a change to how a trigger is
 * authored can't land in one view and miss the other.
 */

import { useState } from 'react';
import { CornerDownRight } from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { type ValidationIssue } from '@/lib/flows/validate';
import { NodeKeySelect } from './forms/fields';
import { IssueLine } from './validation-panel';
import { type BuilderState } from './flow-editor-state';

type SetState = React.Dispatch<React.SetStateAction<BuilderState>>;

/**
 * Comma-separated keyword entry. Keeps a local draft string so the
 * comma (and trailing space) the user types survive until they're done
 * — parsing into the keywords array on every keystroke stripped the
 * trailing comma the instant it was typed, making it impossible to
 * start a second keyword (issue #234). We commit on blur / Enter, then
 * re-display the cleaned, rejoined form. Seeded once on mount; the
 * component unmounts/remounts when the trigger type changes, so the
 * seed stays in sync. Mirrors the automations builder's KeywordMatchConfig.
 */
export function KeywordsInput({
  keywords,
  onChange,
}: {
  keywords: string[];
  onChange: (keywords: string[]) => void;
}) {
  const [draft, setDraft] = useState(keywords.join(', '));

  function commit() {
    const parsed = draft
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    setDraft(parsed.join(', '));
    onChange(parsed);
  }

  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      placeholder="support, help, hi"
      className="bg-muted"
    />
  );
}

/**
 * What starts the flow. `stacked` lays the fields in one column for the
 * ~340px inspector; the list view keeps the two-up grid it had.
 */
export function TriggerPanel({
  state,
  setState,
  triggerIssues,
  stacked = false,
}: {
  state: BuilderState;
  setState: SetState;
  triggerIssues: ValidationIssue[];
  stacked?: boolean;
}) {
  return (
    <section className="border-border bg-card rounded-lg border p-4">
      <h2 className="text-foreground mb-3 text-sm font-semibold">Trigger</h2>
      <div
        className={
          stacked
            ? 'flex flex-col gap-3'
            : 'grid grid-cols-1 gap-3 md:grid-cols-2'
        }
      >
        <div>
          <label className="text-muted-foreground mb-1 block text-xs">
            When…
          </label>
          <Select
            value={state.trigger_type}
            onValueChange={(v) =>
              setState((s) => ({
                ...s,
                trigger_type: v as BuilderState['trigger_type'],
                trigger_config:
                  v === 'keyword' ? { keywords: [] } : v === 'manual' ? {} : {},
              }))
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keyword">
                A message contains a keyword
              </SelectItem>
              <SelectItem value="first_inbound_message">
                Customer&apos;s first ever inbound message
              </SelectItem>
              <SelectItem value="manual">
                Manual only (no auto-trigger)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {state.trigger_type === 'keyword' && (
          <div>
            <label className="text-muted-foreground mb-1 block text-xs">
              Keywords (comma-separated)
            </label>
            <KeywordsInput
              keywords={
                Array.isArray(state.trigger_config.keywords)
                  ? (state.trigger_config.keywords as string[])
                  : []
              }
              onChange={(keywords) =>
                setState((s) => ({
                  ...s,
                  trigger_config: { ...s.trigger_config, keywords },
                }))
              }
            />
          </div>
        )}
      </div>
      {triggerIssues.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {triggerIssues.map((i, ix) => (
            <IssueLine key={ix} issue={i} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Which node the run enters on. Rendered as a labelled block when
 * `stacked` (inspector), and as the original one-line row otherwise.
 */
export function EntryPicker({
  state,
  setState,
  stacked = false,
}: {
  state: BuilderState;
  setState: SetState;
  stacked?: boolean;
}) {
  if (state.nodes.length === 0) return null;

  const picker = (
    <NodeKeySelect
      value={state.entry_node_id}
      nodes={state.nodes}
      onChange={(key) => setState((s) => ({ ...s, entry_node_id: key }))}
      placeholder="Pick the first node…"
      className={stacked ? 'w-full' : 'max-w-xs flex-1'}
    />
  );

  if (stacked) {
    return (
      <section className="border-border bg-card rounded-lg border p-4">
        <h2 className="text-foreground mb-1 text-sm font-semibold">
          Entry node
        </h2>
        <p className="text-muted-foreground mb-3 text-xs">
          Where every run starts.
        </p>
        {picker}
      </section>
    );
  }

  return (
    <section className="border-border bg-card flex items-center gap-3 rounded-lg border p-3">
      <CornerDownRight className="text-primary h-4 w-4 shrink-0" />
      <span className="text-muted-foreground text-xs">Entry node:</span>
      {picker}
    </section>
  );
}
