'use client';

/**
 * Right pane of the flow editor — the selected node's config form.
 *
 * WHY DOCKED RATHER THAN A SHEET
 *   The sheet it replaces was an overlay: opening a node's form covered
 *   the graph, so you could not see the branch you were wiring while you
 *   wired it, and every edit was made blind to its context. A docked
 *   column costs ~340px of canvas and gives that back.
 *
 * WHEN NOTHING IS SELECTED it shows the flow's own settings (trigger +
 * entry node) rather than an empty box. Those were previously reachable
 * only from the list view, so a canvas user had to switch views to set a
 * keyword — the pane is never dead space.
 *
 * The form itself is the SAME `NodeConfigForm` the list view mounts.
 * Two editors for one node config would drift, and the one that drifted
 * would be whichever the author wasn't using.
 */

import { Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { NodeConfigForm } from './forms/node-config-form';
import { useFlowEditor } from './flow-editor-state';
import { EntryPicker, TriggerPanel } from './flow-settings';
import { IssueLine } from './validation-panel';
import { NODE_META, NodeIconChip, nodeColors } from './shared';

export function NodeInspector() {
  const {
    state,
    setState,
    issues,
    selectedNodeKey,
    selectNode,
    updateNodeConfig,
    removeNode,
  } = useFlowEditor();

  const node = selectedNodeKey
    ? (state.nodes.find((n) => n.node_key === selectedNodeKey) ?? null)
    : null;

  return (
    <aside className="border-border bg-card flex w-[340px] shrink-0 flex-col border-l xl:w-[380px]">
      {node === null ? (
        <>
          <header className="border-border border-b px-4 py-3">
            <h2 className="text-foreground text-sm font-semibold">
              Flow settings
            </h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Select a node to edit it, or drag one in from the left.
            </p>
          </header>
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
            <TriggerPanel
              state={state}
              setState={setState}
              triggerIssues={issues.filter((i) => i.scope === 'trigger')}
              stacked
            />
            <EntryPicker state={state} setState={setState} stacked />
          </div>
        </>
      ) : (
        (() => {
          const meta = NODE_META[node.node_type];
          const c = nodeColors(node.node_type);
          const isEntry = state.entry_node_id === node.node_key;
          const nodeIssues = issues.filter(
            (i) => i.scope === 'node' && i.node_key === node.node_key
          );
          return (
            <>
              <header className="border-border flex items-start gap-3 border-b px-4 py-3">
                <NodeIconChip
                  type={node.node_type}
                  size={34}
                  iconSize={17}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="truncate text-[11px] font-semibold tracking-wider uppercase"
                      style={{ color: c.text }}
                    >
                      {meta.label}
                    </span>
                    {isEntry && (
                      <span className="text-accent-green rounded bg-green-500/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase">
                        Entry
                      </span>
                    )}
                  </div>
                  <code className="text-muted-foreground mt-0.5 block truncate font-mono text-[10.5px]">
                    {node.node_key}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={() => selectNode(null)}
                  title="Close (back to flow settings)"
                  aria-label="Close node inspector"
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>

              <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
                <NodeConfigForm
                  node={node}
                  allNodes={state.nodes}
                  showAdvanced={false}
                  onUpdateConfig={(patch) =>
                    updateNodeConfig(node.node_key, patch)
                  }
                />
                {nodeIssues.length > 0 && (
                  <div className="flex flex-col gap-1 rounded-md bg-red-500/5 p-2">
                    {nodeIssues.map((i, ix) => (
                      <IssueLine key={ix} issue={i} />
                    ))}
                  </div>
                )}
              </div>

              <footer className="border-border flex items-center justify-between border-t px-4 py-2.5">
                {!isEntry ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setState((s) => ({ ...s, entry_node_id: node.node_key }))
                    }
                  >
                    Set as entry
                  </Button>
                ) : (
                  <span />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeNode(node.node_key)}
                  className="text-accent-red hover:text-accent-red hover:bg-red-500/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete node
                </Button>
              </footer>
            </>
          );
        })()
      )}
    </aside>
  );
}
