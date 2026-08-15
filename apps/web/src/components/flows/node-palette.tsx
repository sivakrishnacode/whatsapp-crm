'use client';

/**
 * Left rail of the flow editor — every node type you can add, grouped
 * by category, always on screen.
 *
 * WHY A RAIL AND NOT A DROPDOWN
 *   The add-menu it replaces hid the vocabulary behind a click, so the
 *   only way to learn what a flow could do was to open a menu and read
 *   eleven lines. A permanent rail makes the palette the thing you scan
 *   while thinking, which is how every builder this is measured against
 *   works.
 *
 * TWO WAYS TO ADD, DELIBERATELY
 *   - Drag onto the canvas → lands where you dropped it.
 *   - Click → lands at the centre of the visible viewport.
 *   The click path exists because drag-and-drop is a poor fit for
 *   keyboard and trackpad users, and it is the only path that works
 *   while the canvas is empty on a touch device.
 *
 * Both paths select the new node, so the inspector opens on it — adding
 * a node and configuring it is one gesture, not two.
 *
 * ⚠️ The type list is NOT written here. It comes from
 * `ADDABLE_NODE_TYPES` + `NODE_META`, so a node type added in Phase 2
 * appears in this rail, the list view's menu and the legend at once.
 */

import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { PanelLeftClose, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useFlowEditor } from './flow-editor-state';
import {
  ADDABLE_NODE_TYPES,
  NODE_META,
  NodeIconChip,
  groupNodeTypesByCategory,
  nodeColors,
  type NodeType,
} from './shared';

/**
 * The drag payload's MIME type. Namespaced so a drag that started
 * somewhere else in the app (or in another tab) can't be mistaken for a
 * node drop — `getData` on an unknown type returns "" and we bail.
 */
export const NODE_DND_MIME = 'application/x-converse360-flow-node';

/** Canvas node box, mirrored from flow-canvas so a drop centres. */
const NODE_WIDTH = 240;
const NODE_HEIGHT = 90;

export function NodePalette({
  collapsed,
  onCollapse,
}: {
  collapsed: boolean;
  onCollapse: () => void;
}) {
  const { addNode, updateNodePosition, selectNode } = useFlowEditor();
  const reactFlow = useReactFlow();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = q
      ? ADDABLE_NODE_TYPES.filter((t) => {
          const meta = NODE_META[t];
          return (
            meta.label.toLowerCase().includes(q) ||
            meta.blurb.toLowerCase().includes(q)
          );
        })
      : ADDABLE_NODE_TYPES;
    return groupNodeTypesByCategory(matching);
  }, [query]);

  /**
   * Click-to-add. Drops the node at the centre of the visible viewport
   * so it lands where the author is looking rather than at the origin,
   * which on a panned canvas is usually off screen.
   */
  const addAtViewportCentre = (type: NodeType) => {
    const key = addNode(type);
    selectNode(key);
    const root = document.querySelector('.react-flow') as HTMLElement | null;
    // No canvas mounted (list view, or a test env): addNode's default
    // (0,0) stands and the node is still added — never swallow the add.
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const centre = reactFlow.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    updateNodePosition(
      key,
      centre.x - NODE_WIDTH / 2,
      centre.y - NODE_HEIGHT / 2
    );
  };

  if (collapsed) return null;

  return (
    <aside className="border-border bg-card flex w-[236px] shrink-0 flex-col border-r">
      <div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
        <div className="relative flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes"
            aria-label="Search node types"
            className="bg-muted h-8 pl-7 text-xs"
          />
        </div>
        <button
          type="button"
          onClick={onCollapse}
          title="Hide the node palette"
          aria-label="Hide the node palette"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {groups.length === 0 ? (
          <p className="text-muted-foreground px-1 py-6 text-center text-xs">
            No node matches “{query}”.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.id} className="mb-4 last:mb-0">
              <h3 className="text-muted-foreground mb-2 px-1 text-[10.5px] font-semibold tracking-wider uppercase">
                {group.label}
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {group.types.map((type) => (
                  <PaletteTile
                    key={type}
                    type={type}
                    onAdd={() => addAtViewportCentre(type)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}

function PaletteTile({ type, onAdd }: { type: NodeType; onAdd: () => void }) {
  const meta = NODE_META[type];
  const c = nodeColors(type);
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(NODE_DND_MIME, type);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={onAdd}
      title={meta.blurb}
      style={{ '--nc-ring': c.ring } as React.CSSProperties}
      className={cn(
        'border-border bg-card-2 flex cursor-grab flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-center transition-colors',
        'hover:bg-muted hover:border-[var(--nc-ring)] active:cursor-grabbing'
      )}
    >
      <NodeIconChip
        type={type}
        size={28}
        iconSize={15}
        className="rounded-md"
      />
      <span className="text-foreground text-[11px] leading-tight font-medium">
        {meta.label}
      </span>
    </button>
  );
}
