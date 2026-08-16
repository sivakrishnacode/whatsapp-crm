'use client';

/**
 * Validation, surfaced in the editor's TOP BAR — and only when there is
 * something to say.
 *
 * ⚠️ SILENCE IS THE CLEAN STATE. This used to be a permanent bar pinned
 * to the bottom of the editor reading "No issues. Ready to activate."
 * It was on screen for the entire life of every healthy flow, costing a
 * row of canvas to tell the author nothing — and a status line that is
 * almost always green is one nobody reads on the day it turns red.
 * Readiness is already expressed by the Activate button being enabled.
 *
 * Node-scoped issues are clickable: tapping one calls
 * `requestFlash(node_key)` on the editor context. List view's useEffect
 * on `flashKey` expands + scrolls + flashes the row; canvas view's pans
 * the viewport + flashes the card. Both views read the same flashKey so
 * this needs no per-view plumbing.
 *
 * Trigger-scoped issues are NOT clickable — trigger config is a form,
 * not a graph node, and it is already on screen in the inspector.
 */

import { CircleAlert, TriangleAlert } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { ValidationIssue } from '@/lib/flows/validate';
import { useFlowEditor } from './flow-editor-state';

/**
 * The header badge. Renders NOTHING when the flow is clean.
 */
export function ValidationBadge() {
  const { issues, requestFlash } = useFlowEditor();

  if (issues.length === 0) return null;

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  // Errors set the tone whenever there is one — a flow with 1 error and
  // 6 warnings cannot be activated, and amber would undersell that.
  const blocking = errors.length > 0;

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors',
          blocking
            ? 'text-accent-red border-red-500/40 bg-red-500/10 hover:bg-red-500/15'
            : 'text-accent-amber border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15'
        )}
      >
        {blocking ? (
          <>
            <CircleAlert className="h-3.5 w-3.5" />
            {errors.length} issue{errors.length === 1 ? '' : 's'}
          </>
        ) : (
          <>
            <TriangleAlert className="h-3.5 w-3.5" />
            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(420px,90vw)] p-2">
        <p className="text-muted-foreground px-2 pt-1 pb-2 text-[11px]">
          {blocking
            ? 'Fix these before this flow can go live.'
            : 'Worth a look — none of these block activation.'}
        </p>
        <div className="flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto">
          {[...errors, ...warnings].map((i, ix) => (
            <IssueLine key={ix} issue={i} onJump={requestFlash} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Exported so the per-node card (list view) and the trigger panel
 * can render the same "icon + node key chip + message" formatting
 * for their own per-row issue lists without re-implementing the
 * tone / icon / accessibility logic.
 */
export function IssueLine({
  issue,
  onJump,
}: {
  issue: ValidationIssue;
  onJump?: (key: string) => void;
}) {
  const tone =
    issue.severity === 'error' ? 'text-accent-red' : 'text-accent-amber';
  const iconTone =
    issue.severity === 'error' ? 'text-accent-red' : 'text-accent-amber';
  const body = (
    <>
      <CircleAlert className={cn('mt-0.5 h-3 w-3 shrink-0', iconTone)} />
      <span className="min-w-0 flex-1">
        {issue.node_key && (
          <code className="bg-muted text-muted-foreground mr-1 rounded px-1 py-0.5 text-[10px]">
            {issue.node_key}
          </code>
        )}
        {issue.message}
      </span>
    </>
  );

  // Only node-scoped issues can jump; trigger-scoped issues have no
  // destination (the trigger panel is list-only and already at the
  // top of that view).
  if (issue.node_key && onJump) {
    return (
      <button
        type="button"
        onClick={() => onJump(issue.node_key!)}
        className={cn(
          'hover:bg-muted/60 flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors',
          tone
        )}
        aria-label={`Jump to node ${issue.node_key}`}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md px-2 py-1 text-xs',
        tone
      )}
    >
      {body}
    </div>
  );
}
