'use client';

/**
 * Full-screen chrome for the flow editor.
 *
 *   ┌ top bar — name, status, Test / Runs / Activate / Save ──────┐
 *   ├ palette │            canvas             │ inspector ────────┤
 *   └ validation bar ─────────────────────────────────────────────┘
 *
 * WHY `fixed inset-0`
 *   Three columns that all want vertical room cannot share a page with
 *   the dashboard rail and a scrolling content column — the canvas ended
 *   up a letterbox about 300px tall, which is the complaint this rebuild
 *   answers. Same decision, and the same implementation, as the
 *   automation editor (`automation-builder.tsx`) and the form editor.
 *
 * WHY ONE ReactFlowProvider AROUND ALL THREE PANES
 *   The palette adds a node at the centre of the VISIBLE viewport, which
 *   means it needs `useReactFlow()` — and that only works inside a
 *   provider. Wrapping the whole workspace (rather than just the canvas)
 *   is what lets a pane outside the graph talk about coordinates in it.
 *
 * The Canvas / List toggle survives. The list is the only view that
 * works on a phone (canvas handles are ~10px and drag-to-connect is not
 * a finger workflow), so below `md` it is forced and the toggle hides —
 * along with the palette and inspector, which are canvas affordances.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { GitFork, List, PanelLeftOpen } from 'lucide-react';
import { ReactFlowProvider } from '@xyflow/react';

import { FlowBuilder } from './flow-builder';
import { FlowCanvas } from './flow-canvas';
import { FlowSimulator } from './flow-simulator';
import { FlowEditorProvider } from './flow-editor-state';
import { FlowResourcesProvider } from './flow-resources';
import { EditorHeader } from './header';
import { NodeInspector } from './node-inspector';
import { NodePalette } from './node-palette';
import { NODE_META, nodeColors, type NodeType } from './shared';
import { cn } from '@/lib/utils';
import type { FlowRow, FlowNodeRow } from '@/lib/flows/types';
import { takeFlowDraft } from '@/lib/flows/ai-draft';

/**
 * Below this viewport width we force list view and hide the toggle.
 * Canvas with drag-to-connect on a phone is unusable — handles are
 * ~10px and live finger drags from one node to another aren't a
 * practical workflow. Matches Tailwind's `md` breakpoint.
 */
const MOBILE_BREAKPOINT = '(max-width: 767px)';

type View = 'canvas' | 'list';

const STORAGE_KEY = 'converse360.flowEditor.view';
const PALETTE_STORAGE_KEY = 'converse360.flowEditor.palette';

// Legend covers every node type, derived from NODE_META so a new type
// can't silently go undocumented. NODE_META's key order already reads
// the way a flow flows: start → talk → capture → branch → mutate → end.
const LEGEND_TYPES = Object.keys(NODE_META) as NodeType[];

interface Props {
  initialFlow: FlowRow;
  initialNodes: FlowNodeRow[];
}

export function FlowEditorShell({ initialFlow, initialNodes }: Props) {
  // A draft handed over from /flows ("describe it and I'll build it").
  // Read ONCE and removed by `takeFlowDraft`, so a refresh does not
  // re-seed a draft the author has since edited.
  const searchParams = useSearchParams();
  const handoff = searchParams.get('ai');
  const [seeded] = useState(() => takeFlowDraft(handoff));

  const [view, setView] = useState<View>(() => {
    const saved = readStored(STORAGE_KEY, 'canvas');
    return saved === 'list' ? 'list' : 'canvas';
  });
  const [paletteOpen, setPaletteOpen] = useState(
    () => readStored(PALETTE_STORAGE_KEY, 'open') === 'open'
  );

  const isMobile = useMatchMedia(MOBILE_BREAKPOINT);
  const effectiveView: View = isMobile ? 'list' : view;
  const [simulatorOpen, setSimulatorOpen] = useState(false);

  const choose = (next: View) => {
    setView(next);
    writeStored(STORAGE_KEY, next);
  };

  const togglePalette = (next: boolean) => {
    setPaletteOpen(next);
    writeStored(PALETTE_STORAGE_KEY, next ? 'open' : 'closed');
  };

  const showCanvasPanes = effectiveView === 'canvas' && !isMobile;

  return (
    <FlowEditorProvider
      initialFlow={initialFlow}
      initialNodes={initialNodes}
      seededDraft={seeded}
    >
      {/* Templates, products, custom fields, flows and agents — fetched
          once here so ten open nodes don't fetch the same lists ten
          times. */}
      <FlowResourcesProvider currentFlowId={initialFlow.id}>
        <ReactFlowProvider>
          <div className="bg-background fixed inset-0 z-40 flex flex-col">
            <EditorHeader onTest={() => setSimulatorOpen(true)} />

            {/* ---- mode row: view toggle + node-type legend ----
              Omitted entirely on mobile (canvas is unavailable there and
              the legend is lg-only), so there's no empty band above the
              stage on small screens. */}
            {!isMobile && (
              <div className="border-border flex items-center gap-3 border-b px-4 py-2">
                <div
                  role="group"
                  aria-label="Editor view"
                  className="border-border bg-muted inline-flex gap-0.5 rounded-lg border p-0.5"
                >
                  <SegButton
                    active={effectiveView === 'canvas'}
                    onClick={() => choose('canvas')}
                    icon={<GitFork className="h-3.5 w-3.5" />}
                    label="Canvas"
                  />
                  <SegButton
                    active={effectiveView === 'list'}
                    onClick={() => choose('list')}
                    icon={<List className="h-3.5 w-3.5" />}
                    label="List"
                  />
                </div>

                {/* Re-opens the palette. Lives here rather than floating on
                  the canvas so the control that hides it and the control
                  that brings it back sit in one predictable place. */}
                {effectiveView === 'canvas' && !paletteOpen && (
                  <button
                    type="button"
                    onClick={() => togglePalette(true)}
                    className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors"
                  >
                    <PanelLeftOpen className="h-3.5 w-3.5" />
                    Nodes
                  </button>
                )}

                <div className="ml-auto hidden flex-wrap items-center gap-x-3.5 gap-y-1.5 lg:flex">
                  {LEGEND_TYPES.map((t) => (
                    <span
                      key={t}
                      className="text-muted-foreground inline-flex items-center gap-1.5 text-[11.5px]"
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: nodeColors(t).solid }}
                      />
                      {NODE_META[t].label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* ---- workspace: palette · stage · inspector ---- */}
            <div className="flex min-h-0 flex-1">
              {showCanvasPanes && (
                <NodePalette
                  collapsed={!paletteOpen}
                  onCollapse={() => togglePalette(false)}
                />
              )}

              <div className="bg-canvas relative min-w-0 flex-1">
                {effectiveView === 'canvas' ? (
                  <FlowCanvas />
                ) : (
                  <div className="absolute inset-0 overflow-y-auto">
                    <FlowBuilder />
                  </div>
                )}
              </div>

              {showCanvasPanes && <NodeInspector />}
            </div>
            {/* No validation bar. Issues live in the top bar and appear
                only when there are any — see `ValidationBadge`. The
                canvas gets that row of height back. */}
          </div>

          <FlowSimulator
            open={simulatorOpen}
            onClose={() => setSimulatorOpen(false)}
          />
        </ReactFlowProvider>
      </FlowResourcesProvider>
    </FlowEditorProvider>
  );
}

/**
 * localStorage read that also survives SSR — this runs inside a
 * useState initializer, where `window` does not exist on the server and
 * the ReferenceError would otherwise blow up the render.
 */
function readStored(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode / storage disabled — the preference just doesn't persist.
  }
}

/**
 * Tiny `useMatchMedia` shim. We could pull in `react-responsive` but
 * this is the only consumer and matchMedia is one of those browser
 * APIs that doesn't need a dependency.
 */
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Safari < 14 still uses addListener; addEventListener is the
    // modern path. Both fire identically.
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

function SegButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  );
}
