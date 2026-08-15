'use client';

/**
 * Canvas / mind-map view of a flow. Editable, in parity with the
 * list view for everything except the trigger / header / fallback
 * panels (those are list-only — they don't fit visually inside a
 * node graph and the user can switch to List for them).
 *
 * What this view does:
 *   - Renders every flow_node as a draggable tile, pan + zoom +
 *     minimap. Drag positions persist via the editor context
 *     (writing on dragStop, not every frame).
 *   - Renders edges between nodes, labeled per slot (button title,
 *     "true" / "false", list row title) so a branching flow reads
 *     as a real decision tree.
 *   - Click a node → the DOCKED inspector (a sibling pane, see
 *     `node-inspector.tsx`) edits it. Selection lives in the editor
 *     context because the pane doing the editing is no longer ours.
 *   - Drag from a source handle on one node to a target handle on
 *     another → wires that slot's `next_node_key`. Per-slot handles
 *     for multi-outgoing types (condition, send_buttons, send_list)
 *     so the user picks which branch they're wiring.
 *   - Backspace / Delete on a selected node → removes it AND clears
 *     every inbound `next_node_key` reference (no dangling arrows).
 *   - Delete on a selected edge → clears just that slot.
 *   - Nodes are added by dragging from the palette rail onto the
 *     canvas (they land where you drop them) or by clicking a palette
 *     tile (lands at the viewport centre). Both live in
 *     `node-palette.tsx`.
 *   - Runs dagre auto-layout once on mount for flows whose
 *     `position_x` / `position_y` are all zero (pre-canvas flows
 *     and brand-new flows) — otherwise everything would pile at
 *     the origin.
 *
 * The toggle in `flow-editor-shell.tsx` swaps this in for
 * `<FlowBuilder>` on the same page. Both views share the same
 * `BuilderState` via `useFlowEditor()` — toggling never resets
 * unsaved edits, and a drag here updates the same nodes array the
 * list view reads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Node as RfNode,
  type Edge as RfEdge,
  type NodeChange,
  type NodeProps,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { cn } from '@/lib/utils';
import {
  applyEdgeConnection,
  deriveCanvasEdges,
  outgoingSlots,
} from '@/lib/flows/edges';
import { autoLayout, shouldAutoLayout } from '@/lib/flows/layout';
import {
  ADDABLE_NODE_TYPES,
  NODE_META,
  NodeIconChip,
  nodeColors,
  summarizeNode,
  type BuilderNode,
  type NodeType,
} from './shared';
import { NODE_DND_MIME } from './node-palette';
import { useFlowEditor } from './flow-editor-state';

// React-Flow node `data` payload — the bits our custom renderer needs.
interface NodeData extends Record<string, unknown> {
  node: BuilderNode;
  isEntry: boolean;
  /** Validator's "look here" pulse — flashes the card border for
   *  ~1.6s. Drives a CSS animation, doesn't change layout. */
  isFlashed: boolean;
}

const NODE_WIDTH = 240;
// Best-effort default; actual height varies by summary length but
// dagre needs SOMETHING to compute rank spacing. Underestimating is
// safer than over (tighter layout that still doesn't overlap).
const NODE_HEIGHT = 90;

// ============================================================
// Custom node — one card per flow node, styled to match the list
// view's collapsed card so the two views feel like the same product.
// ============================================================

// Echo the design's green/red branch ports for the condition node's
// true / false slots; every other slot inherits the node's own hue.
// The true/false hues are derived from the start (emerald) and handoff
// (rose) node colors so all branch/port colors stay single-sourced in
// NODE_HUE — a palette tweak there can't leave these stale.
function slotColor(nodeType: NodeType, slotId: string, fallback: string) {
  if (nodeType === 'condition' && slotId === 'true') {
    return nodeColors('start').solid;
  }
  if (nodeType === 'condition' && slotId === 'false') {
    return nodeColors('handoff').solid;
  }
  return fallback;
}

function FlowNodeCard({ data, selected }: NodeProps) {
  const { node, isEntry, isFlashed } = data as NodeData;
  const meta = NODE_META[node.node_type];
  const c = nodeColors(node.node_type);
  const summary = summarizeNode(node);
  const slots = outgoingSlots(node);
  // Start nodes are entry-only; nothing ever targets them, so they
  // don't need an incoming Handle. Every other node type accepts
  // incoming edges (including terminal handoff / end — they're the
  // common targets).
  const hasTarget = node.node_type !== 'start';
  // Single-slot nodes get a single source handle floated on the right
  // edge of the card. Multi-slot nodes (condition, send_buttons,
  // send_list) render slot rows inline so each handle visually sits
  // next to the slot it represents.
  const isMultiSlot = slots.length > 1;
  return (
    <div
      style={
        {
          '--nc': c.solid,
          '--nc-soft': c.soft,
          '--nc-ring': c.ring,
          '--nc-text': c.text,
          borderColor: selected ? c.solid : undefined,
          boxShadow: selected
            ? `0 0 0 1px ${c.solid}, 0 14px 36px -12px ${c.ring}`
            : undefined,
        } as React.CSSProperties
      }
      className={cn(
        'bg-card relative max-w-[260px] min-w-[220px] rounded-xl border px-3.5 py-3 text-left shadow-[0_2px_6px_rgba(0,0,0,0.18)] transition-[box-shadow,border-color]',
        selected
          ? 'border-[var(--nc)]'
          : 'border-border hover:border-[var(--nc-ring)]',
        // Flash overrides hover/selected colors briefly. Tailwind's
        // built-in `animate-pulse` is too gentle; a ring with the
        // amber accent matches the list view's flash semantics.
        isFlashed && '!border-amber-400 ring-2 ring-amber-400/60'
      )}
    >
      {hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          className="!bg-card !h-2.5 !w-2.5 !border-2 !border-[var(--nc-ring)]"
        />
      )}

      <div className="flex items-center gap-2">
        <NodeIconChip
          type={node.node_type}
          size={24}
          iconSize={14}
          className="rounded-md"
        />
        <span
          className="truncate text-[10.5px] font-semibold tracking-wider uppercase"
          style={{ color: c.text }}
        >
          {meta.label}
        </span>
        {isEntry && (
          <span className="border-border text-muted-foreground ml-auto rounded border px-1.5 py-0.5 text-[8.5px] font-bold tracking-[0.1em] uppercase">
            Entry
          </span>
        )}
      </div>
      <div className="text-muted-foreground mt-2 truncate font-mono text-[11px]">
        {node.node_key}
      </div>
      {summary && (
        <div className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-relaxed">
          {summary}
        </div>
      )}

      {isMultiSlot && (
        <div className="border-border mt-2.5 flex flex-col gap-1 border-t pt-2.5">
          {slots.map((slot) => (
            <div
              key={slot.id}
              className="text-muted-foreground relative flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px]"
            >
              <span className="truncate" title={slot.label}>
                {slot.label}
              </span>
              <Handle
                type="source"
                id={slot.id}
                position={Position.Right}
                style={{
                  borderColor: slotColor(node.node_type, slot.id, c.solid),
                }}
                // Override default absolute positioning so the handle
                // sits flush with the right edge of the card instead
                // of floating at vertical center. The negative offset
                // matches the card's px-3 + the handle's own radius.
                className="!bg-card !relative !top-auto !right-auto !h-2.5 !w-2.5 !translate-x-[14px] !transform-none !border-2"
              />
            </div>
          ))}
        </div>
      )}

      {!isMultiSlot && slots.length === 1 && (
        <Handle
          type="source"
          id={slots[0].id}
          position={Position.Right}
          style={{ borderColor: c.solid }}
          className="!bg-card !h-2.5 !w-2.5 !border-2"
        />
      )}
    </div>
  );
}

const NODE_TYPES = { flow: FlowNodeCard };

// ============================================================
// Root canvas
// ============================================================

/**
 * Outer wrapper provides the React-Flow context to the inner body,
 * so `useReactFlow()` works from anywhere in `FlowCanvasInner`
 * (notably, the pan-to-flash effect). The split is required because
 * useReactFlow() must be called inside a ReactFlowProvider.
 */
/**
 * The ReactFlowProvider now lives in `flow-editor-shell.tsx`, wrapping
 * all three panes — the palette needs `useReactFlow()` to place a
 * click-added node at the viewport centre, and a provider scoped to the
 * canvas alone would not reach it. This component is mounted inside
 * that provider.
 */
export function FlowCanvas() {
  return <FlowCanvasInner />;
}

function FlowCanvasInner() {
  const {
    state,
    updateNodeConfig,
    updateNodePosition,
    updateNodePositions,
    removeNode,
    addNode,
    selectedNodeKey,
    selectNode,
    flashKey,
  } = useFlowEditor();
  const reactFlow = useReactFlow();
  const builderNodes = state.nodes;
  const entryNodeId = state.entry_node_id;

  const autoLayoutPositions = useMemo(() => {
    const canvasEdges = deriveCanvasEdges(builderNodes);

    return shouldAutoLayout(builderNodes)
      ? autoLayout(
          builderNodes.map((n) => ({
            id: n.node_key,
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
          })),
          canvasEdges.map((e) => ({ source: e.source, target: e.target })),
          { direction: 'TB' }
        )
      : null;
  }, [builderNodes]);

  // If dagre had to place an all-zero flow, persist the generated
  // positions into editor state once. Otherwise the next drag would
  // save only the dragged node and every other node would fall back
  // to (0,0), which feels like nodes teleporting around the canvas.
  const persistedAutoLayoutRef = useRef(false);
  useEffect(() => {
    if (!autoLayoutPositions || persistedAutoLayoutRef.current) return;
    persistedAutoLayoutRef.current = true;
    updateNodePositions(
      Object.fromEntries(
        [...autoLayoutPositions].map(([key, pos]) => [key, pos])
      )
    );
  }, [autoLayoutPositions, updateNodePositions]);

  const derivedRfNodes = useMemo(() => {
    const nodes: RfNode<NodeData>[] = builderNodes.map((n) => {
      const fallback = autoLayoutPositions?.get(n.node_key);
      return {
        id: n.node_key,
        type: 'flow',
        position: {
          x: fallback?.x ?? n.position_x ?? 0,
          y: fallback?.y ?? n.position_y ?? 0,
        },
        // Selection is driven by the editor context, not by React
        // Flow's internal state, because it is now shared with a pane
        // outside the graph. A node added from the palette is selected
        // the moment it lands, so the card the inspector is editing is
        // also the card highlighted on the canvas — the two cannot
        // disagree about what you are looking at.
        selected: n.node_key === selectedNodeKey,
        data: {
          node: n,
          isEntry: n.node_key === entryNodeId,
          isFlashed: n.node_key === flashKey,
        },
      };
    });

    return nodes;
  }, [
    builderNodes,
    entryNodeId,
    flashKey,
    autoLayoutPositions,
    selectedNodeKey,
  ]);

  const [rfNodes, setRfNodes] = useState<RfNode<NodeData>[]>(derivedRfNodes);

  useEffect(() => {
    setRfNodes(derivedRfNodes);
  }, [derivedRfNodes]);

  const rfEdges = useMemo(() => {
    const canvasEdges = deriveCanvasEdges(builderNodes);

    // sourceHandle is now wired up — the FlowNodeCard renders a Handle
    // per slot whose id matches the scheme in edges.ts, so React-Flow
    // can hang the arrow off the right place on each card.
    const rfEdges: RfEdge[] = canvasEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      label: e.label,
      // Mode-aware via CSS tokens so edge chrome flips with light/dark.
      labelStyle: { fill: 'var(--muted-foreground)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--card)' },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      style: { stroke: 'var(--border)', strokeWidth: 1.5 },
    }));

    return rfEdges;
  }, [builderNodes]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<RfNode<NodeData>>[]) => {
      setRfNodes((nodes) => applyNodeChanges(changes, nodes));
    },
    []
  );

  // Drag-to-position: React-Flow tracks the visual drag internally and
  // fires this once on release. We write the final coordinate back to
  // the editor context (which flips `dirty`); save then ships the new
  // positions in the existing PUT /api/flows/[id] body (the route
  // already destructures position_x / position_y per migration 010).
  // Writing only on dragStop (not on every position-change tick during
  // the drag) keeps state updates cheap on long drags.
  const handleNodeDragStop = useCallback<OnNodeDrag<RfNode<NodeData>>>(
    (_event, node) => {
      updateNodePosition(node.id, node.position.x, node.position.y);
    },
    [updateNodePosition]
  );

  // Pan to the flashed node when the validator panel requests one.
  // Animate over 400ms; landing zoom is whatever the user already has
  // (don't force a zoom reset — that would be jarring mid-edit).
  useEffect(() => {
    if (!flashKey) return;
    const node = builderNodes.find((n) => n.node_key === flashKey);
    if (!node) return;
    const x = (node.position_x ?? 0) + NODE_WIDTH / 2;
    const y = (node.position_y ?? 0) + NODE_HEIGHT / 2;
    reactFlow.setCenter(x, y, {
      zoom: reactFlow.getZoom(),
      duration: 400,
    });
  }, [flashKey, builderNodes, reactFlow]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: RfNode<NodeData>) => {
      selectNode(node.id);
    },
    [selectNode]
  );

  // Clicking empty canvas deselects, which swaps the inspector back to
  // the flow's own settings. Without this the pane would keep showing
  // the last node you touched with no way back short of deleting it.
  const handlePaneClick = useCallback(() => {
    selectNode(null);
  }, [selectNode]);

  // ---- palette drag-and-drop ----
  // The drop lands the node where the pointer released, so the author
  // places it rather than hunting for it afterwards. `screenToFlowPosition`
  // handles pan and zoom, so a drop is accurate at any viewport.
  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(NODE_DND_MIME)) return;
    // Only preventDefault for OUR payload — otherwise the canvas would
    // swallow file drags and every other drop the browser handles.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      const raw = event.dataTransfer.getData(NODE_DND_MIME);
      if (!raw) return;
      // The payload is attacker-irrelevant (same-page drag) but still
      // untrusted input: a value that isn't a known node type would
      // create a node no form can render.
      if (!ADDABLE_NODE_TYPES.includes(raw as NodeType)) return;
      event.preventDefault();
      const position = reactFlow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const key = addNode(raw as NodeType);
      updateNodePosition(
        key,
        position.x - NODE_WIDTH / 2,
        position.y - NODE_HEIGHT / 2
      );
      selectNode(key);
    },
    [addNode, reactFlow, selectNode, updateNodePosition]
  );

  // Drag-to-connect: React-Flow fires onConnect when the user drops a
  // handle drag onto a target handle. We look up the source node,
  // compute the right config patch via applyEdgeConnection (matches
  // the same slot scheme as deriveCanvasEdges), and dispatch via
  // updateNodeConfig. The resulting state change re-derives edges on
  // the next render — no need to maintain a separate edge list.
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (
        !connection.source ||
        !connection.target ||
        !connection.sourceHandle
      ) {
        return;
      }
      const sourceNode = builderNodes.find(
        (n) => n.node_key === connection.source
      );
      if (!sourceNode) return;
      // Self-loops are a footgun (a button whose target is its own
      // node = infinite reprompt). Reject silently — the user can
      // still wire one via the per-node dropdown if they really want.
      if (connection.source === connection.target) return;
      const patch = applyEdgeConnection(
        sourceNode,
        connection.sourceHandle,
        connection.target
      );
      if (patch) updateNodeConfig(connection.source, patch);
    },
    [builderNodes, updateNodeConfig]
  );

  // Keyboard delete (Backspace / Delete) + drag-to-trash. React-Flow
  // fires this with the set of deleted-node objects; we route each
  // through the editor context's removeNode (which now also unlinks
  // inbound references so no dangling arrows survive). Closing the
  // side panel on delete keeps the UI honest if the user deleted the
  // node currently being edited.
  const handleNodesDelete = useCallback(
    (deleted: RfNode<NodeData>[]) => {
      // `removeNode` clears the inspector's selection itself when it
      // deletes the open node, so there's nothing to do here beyond
      // forwarding each delete.
      for (const n of deleted) removeNode(n.id);
    },
    [removeNode]
  );

  // Edge delete: clear the source node's slot rather than removing
  // anything. Edges are derived from configs, so the only way to
  // "delete" one is to null out its underlying next_node_key.
  const handleEdgesDelete = useCallback(
    (deleted: RfEdge[]) => {
      for (const e of deleted) {
        if (!e.sourceHandle) continue;
        const sourceNode = builderNodes.find((n) => n.node_key === e.source);
        if (!sourceNode) continue;
        const patch = applyEdgeConnection(sourceNode, e.sourceHandle, '');
        if (patch) updateNodeConfig(e.source, patch);
      }
    },
    [builderNodes, updateNodeConfig]
  );

  // An empty flow used to early-return a centered message INSTEAD of
  // the graph, which meant the one canvas you most want to drop a node
  // onto was not a drop target at all. The graph always mounts now and
  // the hint is an overlay on top of it.
  const isEmpty = rfNodes.length === 0;

  return (
    <>
      <div
        className="h-full w-full overflow-hidden"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          onNodesChange={handleNodesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          onConnect={handleConnect}
          onNodesDelete={handleNodesDelete}
          onEdgesDelete={handleEdgesDelete}
          // Default is "Backspace" only — accept both so Mac users
          // hitting Delete (Fn+Backspace) get the same behavior.
          deleteKeyCode={['Backspace', 'Delete']}
          nodesConnectable={true}
          edgesFocusable={true}
          elementsSelectable={true}
          // Lower default min/max zoom than the lib's defaults; the
          // tiles already truncate their summary at a reasonable
          // size, so we don't need to zoom past 1.5x.
          minZoom={0.2}
          maxZoom={1.5}
        >
          {/* Dot grid, matching the design's faint canvas backdrop. */}
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1.4}
            color="var(--border)"
          />
          <Controls
            className="!border-border !bg-card [&_button]:!border-border [&_button]:!bg-card [&_button:hover]:!bg-muted [&_button_svg]:!fill-foreground !overflow-hidden !rounded-xl !border !shadow-[0_6px_20px_-8px_rgba(0,0,0,0.5)]"
            showInteractive={false}
          />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              nodeColors((n.data as NodeData).node.node_type).solid
            }
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
            maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
            className="!border-border !bg-card !rounded-xl !border !shadow-[0_6px_20px_-8px_rgba(0,0,0,0.5)]"
          />
          {isEmpty && (
            // pointer-events-none so the hint never blocks the drop it
            // is asking for.
            <Panel
              position="top-center"
              className="pointer-events-none !top-1/2 !left-1/2 !-translate-x-1/2 !-translate-y-1/2"
            >
              <div className="border-border bg-card/80 text-muted-foreground rounded-xl border border-dashed px-6 py-5 text-center text-sm backdrop-blur-sm">
                <p className="text-foreground font-medium">No nodes yet.</p>
                <p className="mt-1 text-xs">
                  Drag a node in from the left — or click one to drop it here.
                </p>
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>
    </>
  );
}
