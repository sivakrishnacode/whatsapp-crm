'use client';

/**
 * The automation editor: a React Flow canvas with a docked inspector.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE FLOWS CANVAS
 *   A flow is a real graph — nodes store pointers at each other. An
 *   automation is a SEQUENCE with two-way branches, and that is what the
 *   database stores. So every edge here is derived from the tree
 *   (`lib/automations/graph.ts`) and a drag-to-connect is a MOVE, not a
 *   link: "draw an arrow from A to B" can only honestly mean "B now runs
 *   after A".
 *
 *   The upside is that the picture can never disagree with what will
 *   run, which is the failure mode of an editor that stores its own
 *   layout graph alongside the executable one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge as RfEdge,
  type Node as RfNode,
  type NodeChange,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Sheet, SheetContent } from '@/components/ui/sheet';
import {
  STEP_META,
  blankConfig,
  stepColors,
  TRIGGER_COLORS,
} from '@/lib/automations/step-meta';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  TRIGGER_KEY,
  allKeys,
  blankStep,
  connectSteps,
  deriveEdges,
  uniqueStepKey,
  derivePositions,
  needsAutoLayout,
  duplicateStep,
  findStep,
  flattenSteps,
  insertStep,
  removeStep,
  setStepPosition,
  updateStep,
  updateStepConfig,
  type BuilderStep,
} from '@/lib/automations/graph';
import { declaredVariables, tokensFor } from '@/lib/automations/tokens';
import { validateStep } from '@/lib/automations/validate';
import { stepAvailability } from '@/lib/automations/availability';
import type { AutomationStepType, AutomationTriggerType } from '@/types';
import { StepNodeCard, TriggerNodeCard } from './step-node-card';
import { StepInspector } from './step-inspector';
import { TriggerInspector, TRIGGER_OPTIONS } from './trigger-inspector';
import { AddStepDialog } from './add-step-dialog';
import { useAutomationResources } from './resources';
import { connectionsFor } from '@/lib/automations/connectors';
import type { AppPreset } from '@/lib/automations/app-presets';
import { Plus } from 'lucide-react';

const NODE_TYPES = { step: StepNodeCard, trigger: TriggerNodeCard };

export interface CanvasProps {
  steps: BuilderStep[];
  setSteps: (updater: (steps: BuilderStep[]) => BuilderStep[]) => void;
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  channels: string[];
  currentAutomationId?: string;
  /**
   * Selection lives in the parent so the header's checks panel can jump
   * to the step a finding is about. "Step lookup_order has a problem" is
   * not actionable on a canvas you have to scroll.
   */
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onTriggerTypeChange: (t: AutomationTriggerType) => void;
  onTriggerConfigChange: (c: Record<string, unknown>) => void;
  onChannelsChange: (c: string[]) => void;
}

export function AutomationCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({
  steps,
  setSteps,
  triggerType,
  triggerConfig,
  channels,
  currentAutomationId,
  selectedKey,
  onSelect: setSelectedKey,
  onTriggerTypeChange,
  onTriggerConfigChange,
  onChannelsChange,
}: CanvasProps) {
  const reactFlow = useReactFlow();
  const isNarrow = useIsNarrow();
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Connected apps, so picking an action can pre-select its account. */
  const { connections } = useAutomationResources();

  const positions = useMemo(() => derivePositions(steps), [steps]);
  const edges = useMemo(() => deriveEdges(steps), [steps]);
  const flat = useMemo(() => flattenSteps(steps), [steps]);
  const variables = useMemo(() => declaredVariables(steps), [steps]);

  // Availability is recomputed per render rather than stored on the
  // step: it depends on the TRIGGER and the CHANNELS, both of which live
  // outside the step and can change after it was added. A cached answer
  // would go stale the moment somebody switches the trigger to
  // Instagram — which is exactly when it matters.
  const availabilityFor = useCallback(
    (type: AutomationStepType) => stepAvailability(type, channels, triggerType),
    [channels, triggerType]
  );

  // Which cards something rejoins at, so those cards can render the
  // dashed target port and the "rejoins" chip. Derived rather than
  // stored: it is a fact about the tree, not a property of a step.
  const rejoinTargets = useMemo(
    () => new Set(edges.filter((e) => e.dashed).map((e) => e.target)),
    [edges]
  );

  const derivedNodes = useMemo<RfNode[]>(() => {
    const triggerPos = positions.get(TRIGGER_KEY) ?? { x: 0, y: 0 };
    const nodes: RfNode[] = [
      {
        id: TRIGGER_KEY,
        type: 'trigger',
        position: triggerPos,
        deletable: false,
        data: {
          triggerType,
          label:
            TRIGGER_OPTIONS.find((o) => o.value === triggerType)?.label ??
            triggerType,
          channels,
        },
      },
    ];
    for (const { step } of flat) {
      nodes.push({
        id: step.key,
        type: 'step',
        position: positions.get(step.key) ?? { x: 0, y: 0 },
        // Carried in the derived node, not left to React Flow's own
        // state: local node state is REPLACED whenever the tree changes,
        // so without this, typing one character in the inspector cleared
        // the selection ring on the card being edited.
        selected: step.key === selectedKey,
        data: {
          step,
          invalid: validateStep(step).length > 0,
          rejoinTarget: rejoinTargets.has(step.key),
          availability: availabilityFor(step.step_type),
        },
      });
    }
    return nodes;
  }, [
    flat,
    positions,
    triggerType,
    channels,
    rejoinTargets,
    availabilityFor,
    selectedKey,
  ]);

  // Every step ends up with a position, and it is WRITTEN BACK.
  //
  // Without this the canvas cannot be arranged at all: one unpositioned
  // step — which is every newly added one — keeps derivePositions on the
  // dagre path, and the next layout pass silently overwrites whatever
  // was just dragged.
  //
  // Two cases, and they need different answers:
  //   nothing placed  → adopt the dagre layout wholesale (a legacy
  //                     automation, or a brand-new one).
  //   some placed     → leave the arranged cards alone and drop the new
  //                     one below them. Re-running dagre here would
  //                     rearrange work somebody did by hand.
  useEffect(() => {
    if (!needsAutoLayout(steps)) return;
    setSteps((current) => {
      const all = flattenSteps(current);
      const placed = all.filter(
        (f) =>
          typeof f.step.position_x === 'number' &&
          typeof f.step.position_y === 'number'
      );
      let next = current;

      if (placed.length === 0) {
        for (const [key, pos] of positions) {
          if (key === TRIGGER_KEY) continue;
          next = setStepPosition(next, key, pos.x, pos.y);
        }
        return next;
      }

      // A new step lands to the RIGHT of everything else, on the same
      // line as the last one — the direction the automation reads in.
      const rightmost = Math.max(
        ...placed.map((f) => f.step.position_x as number)
      );
      const lastRow =
        placed.find((f) => f.step.position_x === rightmost)?.step.position_y ??
        0;
      let column = 0;
      for (const f of all) {
        if (typeof f.step.position_x === 'number') continue;
        column += 1;
        next = setStepPosition(
          next,
          f.step.key,
          rightmost + column * (NODE_WIDTH + 80),
          lastRow as number
        );
      }
      return next;
    });
  }, [steps, positions, setSteps]);

  // React Flow needs to own node state (drag positions, selection), but
  // the tree is the source of truth — so local state is REPLACED
  // whenever the derived nodes change.
  //
  // Adjusted during render rather than in an effect: an effect would
  // render once with stale nodes, then again with fresh ones, which on a
  // canvas is a visible flicker of cards in their old positions.
  const [rfNodes, setRfNodes] = useState<RfNode[]>(derivedNodes);
  const [seenNodes, setSeenNodes] = useState(derivedNodes);
  if (seenNodes !== derivedNodes) {
    setSeenNodes(derivedNodes);
    setRfNodes(derivedNodes);
  }

  const rfEdges = useMemo<RfEdge[]>(
    () =>
      edges.map((e) => {
        const stroke =
          e.sourceHandle === 'yes'
            ? 'var(--success)'
            : e.sourceHandle === 'no'
              ? 'var(--destructive)'
              : 'var(--muted-foreground)';
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.dashed ? 'rejoin' : 'in',
          type: 'smoothstep',
          label: e.label,
          // --border measures ~1.2:1 against the stage and is effectively
          // invisible; --muted-foreground clears 5.5:1 in both themes.
          style: {
            stroke,
            strokeWidth: 1.5,
            ...(e.dashed
              ? { strokeDasharray: '2 6', strokeLinecap: 'round' as const }
              : {}),
          },
          labelStyle: { fill: stroke, fontSize: 10.5, fontWeight: 600 },
          labelBgStyle: { fill: 'var(--card)' },
          labelBgPadding: [5, 2] as [number, number],
          labelBgBorderRadius: 4,
        };
      }),
    [edges]
  );

  // ---- mutations -------------------------------------------------

  const addStep = useCallback(
    (
      type: AutomationStepType,
      config?: Record<string, unknown>,
      keyHint?: string
    ) => {
      let newKey: string | null = null;
      setSteps((current) => {
        const taken = allKeys(current);
        const step = blankStep(type, taken, config);
        // An app preset names its step after the app, so the token that
        // reads its response says `steps.slack.body` rather than
        // `steps.http_request_3.body`.
        if (keyHint) step.key = uniqueStepKey(keyHint, taken);
        newKey = step.key;
        // Appended to the end of the root sequence. Dropping it beside
        // whatever is selected sounds friendlier and is worse: a step
        // silently landing inside a branch is how an automation starts
        // doing something nobody wrote.
        return insertStep(current, { kind: 'root' }, current.length, step);
      });
      if (newKey) setSelectedKey(newKey);
    },
    [setSteps, setSelectedKey]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const handle = (connection.sourceHandle ?? 'next') as
        'next' | 'yes' | 'no' | 'continue';
      if (!connection.source || !connection.target) return;
      // "continue" is where the parent sequence resumes after a branch —
      // it is derived from the tree, so there is nothing to wire.
      if (handle === 'continue') return;
      if (connection.source === TRIGGER_KEY) {
        // Wiring the trigger to a step means "start with this step".
        setSteps((current) => {
          const target = findStep(current, connection.target!);
          if (!target) return current;
          const without = removeStep(current, connection.target!);
          return insertStep(without, { kind: 'root' }, 0, target.step);
        });
        return;
      }
      setSteps((current) =>
        connectSteps(current, connection.source!, handle, connection.target!)
      );
    },
    [setSteps]
  );

  const handleNodesChange = useCallback((changes: NodeChange<RfNode>[]) => {
    setRfNodes((nodes) => applyNodeChanges(changes, nodes));
  }, []);

  // Written on release, not on every frame of the drag — a long drag
  // would otherwise re-render the whole tree per tick.
  const handleNodeDragStop = useCallback<OnNodeDrag<RfNode>>(
    (_event, node) => {
      if (node.id === TRIGGER_KEY) return;
      setSteps((current) =>
        setStepPosition(current, node.id, node.position.x, node.position.y)
      );
    },
    [setSteps]
  );

  const handleNodesDelete = useCallback(
    (deleted: RfNode[]) => {
      for (const node of deleted) {
        if (node.id === TRIGGER_KEY) continue;
        setSteps((current) => removeStep(current, node.id));
        if (selectedKey === node.id) setSelectedKey(null);
      }
    },
    [setSteps, selectedKey, setSelectedKey]
  );

  const selected = selectedKey ? findStep(steps, selectedKey) : undefined;
  const inspectorOpen = selectedKey !== null;

  // Keep the selected card visible when the panel opens, WITHOUT
  // `fitView` — re-framing the whole graph loses the author's place.
  // Only nudge by the minimum that clears the panel.
  const nudgedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedKey || selectedKey === TRIGGER_KEY || isNarrow) return;
    if (nudgedFor.current === selectedKey) return;
    nudgedFor.current = selectedKey;
    const pos = positions.get(selectedKey);
    if (!pos) return;
    const viewport = reactFlow.getViewport();
    const screenX = pos.x * viewport.zoom + viewport.x;
    const limit = window.innerWidth - 400 - NODE_WIDTH - 40;
    if (screenX > limit) {
      reactFlow.setCenter(pos.x + NODE_WIDTH / 2, pos.y + NODE_HEIGHT / 2, {
        zoom: viewport.zoom,
        duration: 200,
      });
    }
  }, [selectedKey, positions, reactFlow, isNarrow]);

  const inspector =
    selectedKey === TRIGGER_KEY ? (
      <TriggerInspector
        triggerType={triggerType}
        config={triggerConfig}
        channels={channels}
        currentAutomationId={currentAutomationId}
        onTypeChange={onTriggerTypeChange}
        onConfigChange={onTriggerConfigChange}
        onChannelsChange={onChannelsChange}
        onClose={() => setSelectedKey(null)}
      />
    ) : selected ? (
      <StepInspector
        // Fresh component per step: no stale scroll position, no
        // half-confirmed delete, no draft from the previous step.
        key={selected.step.key}
        step={selected.step}
        groups={tokensFor(steps, selected.step.key, triggerType, variables)}
        availability={availabilityFor(selected.step.step_type)}
        keyTaken={(candidate) =>
          candidate !== selected.step.key && allKeys(steps).has(candidate)
        }
        automationId={currentAutomationId}
        onChangeType={(type) => {
          // The KEY is kept: tokens elsewhere point at this step by name,
          // and silently breaking them because somebody swapped the type
          // would be a worse surprise than losing settings that belonged
          // to the old type anyway.
          setSteps((current) =>
            updateStep(current, selected.step.key, (s) => ({
              ...s,
              step_type: type,
              step_config: blankConfig(type),
              branches: STEP_META[type]?.branching
                ? (s.branches ?? { yes: [], no: [] })
                : undefined,
            }))
          );
        }}
        onChangeConfig={(patch) =>
          setSteps((current) =>
            updateStepConfig(current, selected.step.key, patch)
          )
        }
        onRename={(nextKey) => {
          setSteps((current) =>
            updateStep(current, selected.step.key, (s) => ({
              ...s,
              key: nextKey,
            }))
          );
          setSelectedKey(nextKey);
        }}
        onDuplicate={() =>
          setSteps((current) => {
            const { steps: next, newKey } = duplicateStep(
              current,
              selected.step.key
            );
            if (newKey) setSelectedKey(newKey);
            return next;
          })
        }
        onDelete={() => {
          setSteps((current) => removeStep(current, selected.step.key));
          setSelectedKey(null);
        }}
        onClose={() => setSelectedKey(null)}
      />
    ) : null;

  /**
   * Enter / Space opens the settings for the focused card.
   *
   * React Flow tabs through nodes and handles Enter internally to select
   * one, but it never calls `onNodeClick` for a keypress — so without
   * this, a keyboard user can reach every card and cannot open any of
   * them. Read off the focused element rather than tracking focus in
   * state: the node wrapper is React Flow's DOM, not ours.
   */
  const handleCanvasKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const node = (event.target as HTMLElement)?.closest?.(
        '.react-flow__node'
      );
      const id = node?.getAttribute('data-id');
      if (!id) return;
      event.preventDefault();
      setSelectedKey(id);
    },
    [setSelectedKey]
  );

  return (
    <div className="flex h-full min-h-0">
      <div
        className="bg-canvas relative min-w-0 flex-1"
        onKeyDown={handleCanvasKeyDown}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          onNodesChange={handleNodesChange}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={(_e, node) => setSelectedKey(node.id)}
          onPaneClick={() => setSelectedKey(null)}
          onConnect={handleConnect}
          onNodesDelete={handleNodesDelete}
          deleteKeyCode={['Backspace', 'Delete']}
          // Below the tablet breakpoint the graph stays readable but
          // stops being wireable: 11px ports and finger drags do not
          // combine. Tapping a card still opens its editor.
          nodesDraggable={!isNarrow}
          nodesConnectable={!isNarrow}
          minZoom={0.2}
          maxZoom={1.5}
        >
          {/* Same canvas tokens as the flow editor — two canvases in one
              product must not read as two different surfaces. */}
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.6}
            color="var(--canvas-grid)"
          />
          <Controls
            className="!border-border !bg-card [&_button]:!border-border [&_button]:!bg-card [&_button:hover]:!bg-muted [&_button_svg]:!fill-foreground !overflow-hidden !rounded-xl !border"
            showInteractive={false}
          />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              n.id === TRIGGER_KEY
                ? TRIGGER_COLORS.solid
                : stepColors(
                    (n.data as { step?: BuilderStep })?.step?.step_type ??
                      'send_message'
                  ).solid
            }
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
            maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
            className="!border-border !bg-card !rounded-xl !border"
          />
          <Panel position="top-left" className="!top-4 !left-4">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium shadow-[0_6px_20px_-8px_rgba(0,0,0,0.5)] transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add step
            </button>
          </Panel>
        </ReactFlow>

        {steps.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center">
            <p className="text-muted-foreground border-border bg-card/80 rounded-lg border border-dashed px-4 py-2 text-xs">
              Add your first step — it runs as soon as the trigger fires.
            </p>
          </div>
        )}
      </div>

      {/* Docked at desktop widths; an overlay below them, because a
          400px panel beside a 620px canvas is two unusable things. */}
      {inspectorOpen && !isNarrow && (
        <div className="w-[clamp(360px,30vw,460px)] shrink-0">{inspector}</div>
      )}
      <AddStepDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPickStep={(type) => addStep(type)}
        onPickApp={(preset: AppPreset) =>
          addStep(preset.stepType, { ...preset.config }, preset.id)
        }
        onPickAction={(app, action) => {
          // Pre-select the connection when there is exactly ONE usable
          // account for this app — which is the normal case, and saves a
          // dropdown that has one entry. With two, choosing for them
          // would silently pick which mailbox an email is sent from.
          const usable = connectionsFor(connections, app).filter(
            (c) => c.status === 'active'
          );
          addStep(
            'app_action',
            {
              app: app.app,
              action: action.id,
              connection_id: usable.length === 1 ? usable[0].id : '',
              // Defaults from the spec, so a field with a sensible value
              // starts holding it rather than being empty and required.
              input: Object.fromEntries(
                action.inputs
                  .filter((spec) => spec.default !== undefined)
                  .map((spec) => [spec.key, spec.default])
              ),
            },
            // Names the step after the action, so its output reads
            // `steps.append_row.row_number` rather than
            // `steps.app_action_3.row_number`.
            action.id
          );
        }}
        channels={channels}
        triggerType={triggerType}
      />

      {isNarrow && (
        <Sheet
          open={inspectorOpen}
          onOpenChange={(v) => !v && setSelectedKey(null)}
        >
          <SheetContent side="right" className="w-full p-0 sm:max-w-[420px]">
            {inspector}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

/**
 * Below 1024px the docked panel becomes an overlay and the graph stops
 * being wireable. Same call `flow-editor-shell.tsx` makes, and the same
 * reason: a mouse-sized target does not survive a finger.
 */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

export { STEP_META };
