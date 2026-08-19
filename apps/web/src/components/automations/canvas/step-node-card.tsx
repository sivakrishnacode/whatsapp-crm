'use client';

/**
 * The cards on the automation canvas: one trigger card, one per step.
 *
 * Built to `docs/automation-canvas-design.md` §2–3. The parts that look
 * fussy are the ones carrying meaning:
 *
 *   - `line`, never `solid`, paints every stroke and glyph. The raw hue
 *     fails WCAG 1.4.11 on a light card (2.53:1 for amber); `line` mixes
 *     22% toward `--foreground`, which inverts with the theme.
 *   - A branching step's yes/no ports live INSIDE the card, as two
 *     labelled rows in its footer, each port on its own row's right
 *     edge. Ports floating beside a card get mis-aimed.
 *   - The "continue" port — where execution rejoins the parent sequence
 *     after a branch — leaves the BOTTOM edge as a dashed ring, not the
 *     right as a filled dot. With the spine running left-to-right, right
 *     IS the ordinary next-step direction, so the bypass has to leave
 *     from somewhere else or it reads as a third branch.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Ban,
  CircleAlert,
  CornerDownRight,
  Pause,
  TriangleAlert,
  Zap,
} from 'lucide-react';

import { googleActionIcon } from '@/lib/automations/connectors';
import { cn } from '@/lib/utils';
import {
  STEP_META,
  StepIconChip,
  appActionLabel,
  googleActionLabel,
  TRIGGER_COLORS,
  stepColors,
  summarizeStep,
  type StepColors,
} from '@/lib/automations/step-meta';
import {
  CHANNEL_LABELS,
  type Availability,
} from '@/lib/automations/availability';
import type { BuilderStep } from '@/lib/automations/graph';
import type { AutomationTriggerType } from '@/types';
import { useAutomationResources } from './resources';

export interface StepNodeData extends Record<string, unknown> {
  step: BuilderStep;
  /** Required fields missing — the card says so rather than the save doing it. */
  invalid: boolean;
  /** Something rejoins the parent sequence at this card. */
  rejoinTarget: boolean;
  /** Can this step run on the automation's channels at all? */
  availability: Availability;
}

export interface TriggerNodeData extends Record<string, unknown> {
  triggerType: AutomationTriggerType;
  label: string;
  channels: string[];
}

/** Shared card chrome, so the trigger and a step cannot drift apart. */
function cardStyle(
  c: StepColors,
  selected: boolean,
  disabled: boolean,
  invalid: boolean
): React.CSSProperties {
  return {
    '--nc-line': c.line,
    '--nc-soft': c.soft,
    '--nc-ring': c.ring,
    '--nc-text': c.text,
    // The resting border is hue-tinted because --card on --card-2 is
    // 1.05:1 — the card body is invisible against the stage on its own,
    // and plain --border only reaches ~1.25:1. Full `line` stays
    // reserved for the selected state, which is what 1.4.11 governs.
    borderColor: invalid
      ? 'var(--destructive)'
      : selected
        ? 'var(--nc-line)'
        : 'color-mix(in oklch, var(--border), var(--nc-line) 45%)',
    boxShadow: invalid
      ? '0 0 0 1px var(--destructive), 0 1px 2px oklch(0 0 0 / .12)'
      : selected
        ? '0 0 0 1px var(--nc-line), 0 14px 36px -12px var(--nc-ring)'
        : '0 1px 2px oklch(0 0 0 / .12), 0 4px 12px -6px oklch(0 0 0 / .25)',
    ...(disabled ? { opacity: 0.55, filter: 'saturate(.35)' } : {}),
  } as React.CSSProperties;
}

const HANDLE_CLASS =
  // 11px visual, 24px hit area via the ::after inset — a bare 11px port
  // is under the 24px minimum target size and is genuinely hard to grab.
  '!h-[11px] !w-[11px] !border-2 !bg-card after:absolute after:-inset-[7px] after:content-[""]';

// ============================================================
// Trigger
// ============================================================

export function TriggerNodeCard({ data, selected }: NodeProps) {
  const { label, channels } = data as TriggerNodeData;
  const c = TRIGGER_COLORS;
  return (
    <div
      style={cardStyle(c, Boolean(selected), false, false)}
      className="bg-card w-[264px] rounded-2xl border-2 text-left transition-[box-shadow,border-color] duration-150"
      aria-selected={selected ? 'true' : 'false'}
    >
      {/* The header strip, the 2px border and the larger radius are what
          say "the graph starts here" without depending on the label
          being read or the colour being seen. */}
      <div
        className="flex items-center gap-2 rounded-t-[12px] px-3.5 py-2"
        style={{ background: 'var(--nc-soft)' }}
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: 'var(--nc-soft)', color: 'var(--nc-line)' }}
        >
          <Zap size={14} />
        </span>
        <span
          className="text-[10.5px] font-semibold tracking-wider uppercase"
          style={{ color: 'var(--nc-text)' }}
        >
          Trigger
        </span>
      </div>

      <div className="px-3.5 py-3">
        <div className="text-foreground truncate text-[13px] leading-tight font-semibold">
          {label}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {channels.length === 0 ? (
            <span className="text-muted-foreground text-[11px]">
              All channels
            </span>
          ) : (
            channels.map((ch) => (
              <span
                key={ch}
                className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[10px] capitalize"
              >
                {ch}
              </span>
            ))
          )}
        </div>
      </div>

      <Handle
        type="source"
        id="next"
        position={Position.Right}
        style={{ borderColor: 'var(--nc-line)' }}
        className={HANDLE_CLASS}
      />
    </div>
  );
}

// ============================================================
// Step
// ============================================================

export function StepNodeCard({ data, selected }: NodeProps) {
  const { step, invalid, rejoinTarget, availability } = data as StepNodeData;
  const { apps, googleActions, googleServiceLabels } = useAutomationResources();
  const meta = STEP_META[step.step_type];
  const c = stepColors(step.step_type);
  const cfg = step.step_config;
  const disabled = Boolean(cfg.disabled);
  const continueOnError = cfg.on_error === 'continue';
  const saveAs = typeof cfg.save_as === 'string' ? cfg.save_as.trim() : '';
  const summary = summarizeStep(step.step_type, cfg);
  // A google/app action's real name lives in the catalogue, not in
  // STEP_META — one step type covers every action, so the static label
  // would put "Google action" on a card that is really "Google Sheets ·
  // Append row".
  const label =
    step.step_type === 'google_action'
      ? googleActionLabel(
          cfg as { action?: string },
          googleActions,
          googleServiceLabels
        )
      : step.step_type === 'app_action'
        ? appActionLabel(cfg as { app?: string; action?: string }, apps)
        : (meta?.label ?? step.step_type);
  const branching = Boolean(meta?.branching);
  const categoryLabel = meta?.category ?? 'step';

  return (
    <div
      style={cardStyle(c, Boolean(selected), disabled, invalid)}
      className={cn(
        'bg-card w-[264px] rounded-xl text-left transition-[box-shadow,border-color] duration-150',
        disabled ? 'border border-dashed' : 'border'
      )}
      aria-selected={selected ? 'true' : 'false'}
    >
      <Handle
        type="target"
        id="in"
        position={Position.Left}
        style={{ borderColor: 'var(--nc-line)' }}
        className={HANDLE_CLASS}
      />

      <div className="px-3.5 py-3">
        {/* Row 1 — chip, category, badges */}
        <div className="flex items-center gap-2">
          <StepIconChip
            type={step.step_type}
            size={24}
            iconSize={14}
            className="rounded-md"
            iconSrc={
              step.step_type === 'google_action'
                ? googleActionIcon(cfg as { action?: string }, googleActions)
                : undefined
            }
          />
          <span
            className="truncate text-[10.5px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--nc-text)' }}
          >
            {categoryLabel}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {/* Every badge carries a word or a glyph — never colour alone. */}
            {rejoinTarget && (
              <span className="border-border text-muted-foreground flex items-center gap-0.5 rounded border border-dashed px-1 py-0.5 text-[8.5px] font-bold tracking-[0.08em] uppercase">
                <CornerDownRight size={9} />
                rejoins
              </span>
            )}
            {disabled && (
              <span className="border-border text-muted-foreground flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[8.5px] font-bold tracking-[0.1em] uppercase">
                <Pause size={9} />
                Paused
              </span>
            )}
            {invalid && (
              <span className="bg-destructive-surface text-destructive flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[8.5px] font-bold tracking-[0.1em] uppercase">
                <CircleAlert size={10} />
                Fix
              </span>
            )}
            {/* A step that cannot run on any of this automation's
                channels is dead config. The engine skips it silently at
                run time — correct there, invisible here, which is how an
                Instagram automation ends up with a WhatsApp template
                step that never fires. */}
            {availability?.status === 'never' && (
              <span
                className="bg-destructive-surface text-destructive flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[8.5px] font-bold tracking-[0.1em] uppercase"
                title={availability.reason}
              >
                <Ban size={10} />
                Never runs
              </span>
            )}
            {availability?.status === 'partial' && (
              <span
                className="bg-warning-surface text-warning flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[8.5px] font-bold tracking-[0.1em] uppercase"
                title={availability.reason}
              >
                <TriangleAlert size={10} />
                {availability.unsupported.length > 0
                  ? `Not on ${availability.unsupported.length === 1 ? CHANNEL_LABELS[availability.unsupported[0]] : 'some channels'}`
                  : 'Sometimes skipped'}
              </span>
            )}
          </span>
        </div>

        {/* Row 2 — the step's own name */}
        <div className="text-foreground mt-2 truncate text-[13px] leading-tight font-semibold">
          {label}
        </div>

        {/* Row 3 — omitted entirely when there is nothing to say. A card
            that says nothing should be short, not blank. */}
        {summary && (
          <div
            className="text-muted-foreground mt-1 line-clamp-2 text-[11.5px] leading-relaxed"
            title={summary}
          >
            {summary}
          </div>
        )}

        {/* Row 4 — the reference key, which is how other steps address
            this one. No braces: at 10.5px they are visual grit, and the
            copyable form lives in the inspector. */}
        <div className="mt-2 flex items-center gap-2">
          <span className="text-muted-foreground truncate font-mono text-[10.5px]">
            {step.key}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {saveAs && (
              <span className="text-muted-foreground font-mono text-[9.5px]">
                → vars.{saveAs}
              </span>
            )}
            {continueOnError && (
              <span className="bg-warning-surface text-warning rounded px-1 py-0.5 text-[9px] tracking-wide uppercase">
                on error → continue
              </span>
            )}
          </span>
        </div>
      </div>

      {branching ? (
        <BranchFooter step={step} />
      ) : (
        <Handle
          type="source"
          id="next"
          position={Position.Right}
          style={{ borderColor: 'var(--nc-line)' }}
          className={HANDLE_CLASS}
        />
      )}

      {/* The rejoin port. Right edge, dashed ring, transparent fill —
          three signals that this is not a third branch. */}
      {branching && (
        <Handle
          type="source"
          id="continue"
          position={Position.Bottom}
          style={{
            borderColor: 'var(--muted-foreground)',
            background: 'transparent',
          }}
          className={cn(HANDLE_CLASS, '!border-dashed !bg-transparent')}
        />
      )}
      {rejoinTarget && (
        <Handle
          type="target"
          id="rejoin"
          position={Position.Bottom}
          style={{
            borderColor: 'var(--muted-foreground)',
            background: 'transparent',
          }}
          className={cn(HANDLE_CLASS, '!border-dashed !bg-transparent')}
        />
      )}
    </div>
  );
}

/**
 * Yes / No as a two-column footer with the ports in their own halves.
 *
 * The word, the wash and the port are one object, so a branch cannot be
 * wired by aiming at the wrong dot — which is the failure mode when two
 * bare handles sit 12px apart under a card.
 */
function BranchFooter({ step }: { step: BuilderStep }) {
  const percent =
    step.step_type === 'random_split'
      ? Number(step.step_config.percent ?? 50)
      : null;
  return (
    <div className="border-border relative mt-1 flex flex-col border-t">
      <div className="bg-success-surface relative flex items-center justify-between rounded-bl-[10px] px-3 py-1.5">
        <span className="text-success text-[10px] font-bold tracking-wider uppercase">
          {percent === null ? 'Yes' : `${percent}%`}
        </span>
        <Handle
          type="source"
          id="yes"
          position={Position.Right}
          style={{ borderColor: 'var(--success)', top: '50%' }}
          className={HANDLE_CLASS}
        />
      </div>
      <div className="bg-destructive-surface border-border relative flex items-center justify-between rounded-b-[10px] border-t px-3 py-1.5">
        <span className="text-destructive text-[10px] font-bold tracking-wider uppercase">
          {percent === null ? 'No' : `${100 - percent}%`}
        </span>
        <Handle
          type="source"
          id="no"
          position={Position.Right}
          style={{ borderColor: 'var(--destructive)', top: '50%' }}
          className={HANDLE_CLASS}
        />
      </div>
    </div>
  );
}
