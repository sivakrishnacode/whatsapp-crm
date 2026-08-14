'use client';

/**
 * The docked right-hand inspector — the editor for whichever node is
 * selected.
 *
 * Three flex children, and only the middle one scrolls:
 *   header  — identity: icon, type, reference name, enabled switch
 *   body    — the step's own fields, then Advanced
 *   footer  — duplicate / delete
 *
 * Header and footer are flex siblings rather than `position: sticky`,
 * because sticky inside a scroll container fights base-ui's portalled
 * popovers at the edges — which is exactly where the token picker opens.
 */

import { useState } from 'react';
import { Ban, Copy, TriangleAlert, X } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StepTestPanel } from './step-test-panel';
import { AddStepDialog } from './add-step-dialog';
import { useAutomationResources } from './resources';
import { STEP_CATEGORIES } from '@/lib/automations/step-meta';
import type { AutomationStepType } from '@/types';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  STEP_META,
  appActionLabel,
  StepIconChip,
  stepColors,
} from '@/lib/automations/step-meta';
import type { Availability } from '@/lib/automations/availability';
import type { BuilderStep } from '@/lib/automations/graph';
import type { TokenGroup } from '@/lib/automations/tokens';
import { FieldBlock } from './token-field';
import { StepFields } from './step-fields';

export function StepInspector({
  step,
  groups,
  availability,
  keyTaken,
  automationId,
  onChangeConfig,
  onChangeType,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
}: {
  step: BuilderStep;
  groups: TokenGroup[];
  /** Whether this step can run on the automation's channels at all. */
  availability: Availability;
  /** Other steps' keys — a duplicate is caught here, not at save time. */
  keyTaken: (candidate: string) => boolean;
  /** Saved automation id, so Test can read earlier steps' last outputs. */
  automationId?: string;
  onChangeConfig: (patch: Record<string, unknown>) => void;
  onChangeType: (type: AutomationStepType) => void;
  onRename: (key: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { apps } = useAutomationResources();
  const meta = STEP_META[step.step_type];
  // Same reason as the node card: an app action's name comes from the
  // catalogue, so the inspector header says which app and action rather
  // than the generic type label.
  const headerLabel =
    step.step_type === 'app_action'
      ? appActionLabel(
          step.step_config as { app?: string; action?: string },
          apps,
        )
      : (meta?.label ?? step.step_type);
  const c = stepColors(step.step_type);
  const cfg = step.step_config;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [changingType, setChangingType] = useState(false);

  // NOTE: the canvas mounts this with `key={step.key}`, so selecting a
  // different step gives a fresh component — scrolled to the top, with
  // no half-confirmed delete carried over from the last one. That is why
  // there is no effect here resetting either.

  return (
    <aside
      id="step-inspector"
      aria-label={`${headerLabel} settings`}
      style={{ '--nc-text': c.text } as React.CSSProperties}
      className="border-border bg-popover flex h-full min-h-0 w-full flex-col border-l"
    >
      {/* ---- Header ---- */}
      <div className="border-border flex-none border-b px-4 pt-3.5 pb-3">
        <div className="flex items-start gap-2.5">
          <StepIconChip type={step.step_type} size={32} iconSize={16} />
          <div className="min-w-0 flex-1">
            <div
              className="text-[10.5px] font-semibold tracking-wider uppercase"
              style={{ color: 'var(--nc-text)' }}
            >
              {meta?.category ?? 'step'}
            </div>
            <h2 className="text-foreground truncate text-sm font-semibold">
              {headerLabel}
            </h2>
          </div>
          <label className="flex shrink-0 flex-col items-center gap-1">
            <Switch
              checked={!cfg.disabled}
              onCheckedChange={(v) => onChangeConfig({ disabled: !v })}
              aria-label={cfg.disabled ? 'Enable this step' : 'Pause this step'}
            />
            <span className="text-muted-foreground text-[10px]">
              {cfg.disabled ? 'Paused' : 'On'}
            </span>
          </label>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          >
            <X size={15} />
          </button>
        </div>

        <ReferenceName
          value={step.key}
          keyTaken={keyTaken}
          onRename={onRename}
        />
      </div>

      {/* ---- Setup / Configure / Test ----
          Three stages in the order somebody works: what kind of step is
          this, what does it say, and does it actually do the right
          thing. Test is last because it is only meaningful once the
          other two are filled in. */}
      <Tabs
        defaultValue="configure"
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="border-border bg-transparent flex-none gap-1 border-b px-3 py-1.5">
          <TabsTrigger value="setup" className="text-xs">
            Setup
          </TabsTrigger>
          <TabsTrigger value="configure" className="text-xs">
            Configure
          </TabsTrigger>
          <TabsTrigger value="test" className="text-xs">
            Test
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="setup"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
        >
          <FieldBlock
            label="Step type"
            hint="Changing this keeps the reference name, so tokens pointing at this step still resolve — but the settings start fresh, because they belong to the old type."
          >
            <button
              type="button"
              onClick={() => setChangingType(true)}
              className="border-border bg-muted hover:border-primary/40 flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors"
            >
              <StepIconChip type={step.step_type} size={22} iconSize={12} className="rounded-md" />
              <span className="text-foreground text-[12.5px]">
                {headerLabel}
              </span>
              <span className="text-muted-foreground ml-auto text-[11px]">
                Change
              </span>
            </button>
          </FieldBlock>

          <FieldBlock
            label="Runs on"
            hint="Which channels this step can actually work on, given the automation's trigger and channel scope."
            group
          >
            <p
              className={cn(
                'text-[11.5px] leading-relaxed',
                availability.status === 'never'
                  ? 'text-destructive'
                  : availability.status === 'partial'
                    ? 'text-warning'
                    : 'text-muted-foreground',
              )}
            >
              {availability.reason ?? 'Every channel this automation runs on.'}
            </p>
          </FieldBlock>

          <FieldBlock label="Category" group>
            <p className="text-muted-foreground text-[11.5px]">
              {STEP_CATEGORIES.find((c) => c.id === meta?.category)?.label ??
                meta?.category}
              {' · '}
              {meta?.blurb}
            </p>
          </FieldBlock>
        </TabsContent>

        <TabsContent
          value="configure"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
        >
        {/* Said here as well as on the card, because this is where
            somebody is when they are choosing the template that will
            never send. */}
        {availability.status !== 'ok' && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-md border p-2.5 text-[11.5px] leading-relaxed',
              availability.status === 'never'
                ? 'border-destructive/40 bg-destructive-surface text-destructive'
                : 'border-warning/40 bg-warning-surface text-warning',
            )}
          >
            {availability.status === 'never' ? (
              <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>{availability.reason}</span>
          </div>
        )}

        <StepFields
          // Remounting per step keeps local drafts (KV-table rows, the
          // variable-name draft) from leaking across a selection change.
          key={step.key}
          type={step.step_type}
          config={cfg}
          onChange={onChangeConfig}
          groups={groups}
        />

        <Separator />

        {/* base-ui's Accordion is single-open by default and takes no
            `type` prop — it is not the Radix one. */}
        <Accordion>
          <AccordionItem value="advanced">
            <AccordionTrigger className="text-muted-foreground text-xs font-medium">
              Advanced
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pt-1">
              <FieldBlock
                label="If this step fails"
                hint="Stopping is right when what follows depends on this step. Carrying on is right for a last-mile notification — a third party being down should not cancel the tag and the deal that already worked."
              >
                <div className="space-y-1.5">
                  {(
                    [
                      ['fail', 'Stop the run'],
                      ['continue', 'Carry on to the next step'],
                    ] as const
                  ).map(([value, label]) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-center gap-2 text-[12.5px]"
                    >
                      <input
                        type="radio"
                        name={`on_error_${step.key}`}
                        checked={(cfg.on_error ?? 'fail') === value}
                        onChange={() => onChangeConfig({ on_error: value })}
                        className="accent-primary"
                      />
                      <span className="text-foreground">{label}</span>
                    </label>
                  ))}
                </div>
              </FieldBlock>

              {meta?.outputs && meta.outputs.length > 0 && (
                <FieldBlock
                  label="Also save the result as"
                  hint="Optional. Shorter to reference than the full step path when you use it repeatedly."
                >
                  <div className="flex items-center">
                    <span className="bg-muted text-muted-foreground rounded-l-lg px-2 py-1.5 font-mono text-[11px]">
                      vars.
                    </span>
                    <Input
                      value={String(cfg.save_as ?? '')}
                      onChange={(e) => onChangeConfig({ save_as: e.target.value })}
                      placeholder="order"
                      className="bg-muted rounded-l-none font-mono text-[12px]"
                    />
                  </div>
                </FieldBlock>
              )}

              <FieldBlock label="Note for your team">
                <Textarea
                  value={String(cfg.note ?? '')}
                  onChange={(e) => onChangeConfig({ note: e.target.value })}
                  rows={3}
                  placeholder="Why this step exists…"
                  className="bg-muted"
                />
              </FieldBlock>
            </AccordionContent>
          </AccordionItem>

          {meta?.outputs && meta.outputs.length > 0 && (
            <AccordionItem value="outputs">
              <AccordionTrigger className="text-muted-foreground text-xs font-medium">
                What this step produces
              </AccordionTrigger>
              <AccordionContent className="space-y-1 pt-1">
                {meta.outputs.map((o) => (
                  <button
                    key={o.path}
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        `{{ steps.${step.key}.${o.path} }}`,
                      );
                      toast.success('Token copied');
                    }}
                    className="hover:bg-muted flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left"
                  >
                    <span className="text-foreground text-[12px]">{o.label}</span>
                    <span className="text-muted-foreground truncate font-mono text-[10.5px]">
                      steps.{step.key}.{o.path}
                    </span>
                  </button>
                ))}
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
        </TabsContent>

        <TabsContent
          value="test"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
        >
          <StepTestPanel step={step} automationId={automationId} />
        </TabsContent>
      </Tabs>

      {/* ---- Footer ---- */}
      <div className="border-border flex flex-none items-center justify-between border-t px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onDuplicate}>
          <Copy className="h-3.5 w-3.5" />
          Duplicate
        </Button>
        {/* Inline confirmation rather than a dialog: a modal to delete
            one card is heavier than the action deserves, and an undo-less
            single click is worse. */}
        {confirmingDelete ? (
          <span className="flex items-center gap-1">
            <span className="text-muted-foreground text-[11px]">Delete?</span>
            <Button
              variant="ghost"
              size="sm"
              autoFocus
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="text-destructive hover:bg-destructive/10"
            >
              Delete
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingDelete(true)}
            className="text-destructive hover:bg-destructive/10"
          >
            Delete step
          </Button>
        )}
      </div>

      <AddStepDialog
        open={changingType}
        onOpenChange={setChangingType}
        onPickStep={(type) => onChangeType(type)}
        onPickAction={(app, action) => {
          // Changing an existing step INTO an app action. The connection
          // is left unset deliberately — this path has no way to know
          // which account was meant, and guessing one would silently
          // decide whose mailbox an email goes out from.
          onChangeType('app_action');
          onChangeConfig({
            app: app.app,
            action: action.id,
            connection_id: '',
            input: Object.fromEntries(
              action.inputs
                .filter((spec) => spec.default !== undefined)
                .map((spec) => [spec.key, spec.default]),
            ),
          });
        }}
        onPickApp={(preset) => {
          onChangeType(preset.stepType);
          onChangeConfig(preset.config);
        }}
        channels={[]}
        triggerType={'new_message_received'}
      />
    </aside>
  );
}

/**
 * The step's reference name — what other steps address it by.
 *
 * Coerced to `[a-z0-9_]` ON BLUR, never on keystroke: rewriting under
 * the caret while someone types is hostile, and the server sanitises
 * with the same rules anyway.
 */
function ReferenceName({
  value,
  keyTaken,
  onRename,
}: {
  value: string;
  keyTaken: (candidate: string) => boolean;
  onRename: (key: string) => void;
}) {
  // Seeded on mount; the inspector is keyed by step, and a rename
  // re-keys it, so the draft is always the current name without an
  // effect writing over what someone is typing.
  const [draft, setDraft] = useState(value);

  const clean = draft
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const duplicate = clean !== value && keyTaken(clean);

  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-1">
        <span className="bg-muted text-muted-foreground rounded-l px-1.5 py-1 font-mono text-[11px]">
          steps.
        </span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (!clean || duplicate) {
              setDraft(value);
              return;
            }
            if (clean !== value) onRename(clean);
          }}
          aria-invalid={duplicate || undefined}
          aria-label="Reference name"
          className={cn(
            'text-foreground hover:bg-muted focus:bg-muted min-w-0 flex-1 rounded-r bg-transparent px-1.5 py-1 font-mono text-[12px] outline-none',
            duplicate && 'text-destructive underline decoration-current',
          )}
        />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(`{{ steps.${value} }}`);
            toast.success('Token copied');
          }}
          aria-label="Copy this step's token"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded"
        >
          <Copy size={12} />
        </button>
      </div>
      {duplicate && (
        <p className="text-destructive mt-1 text-[11px]">
          Another step already uses {clean}.
        </p>
      )}
    </div>
  );
}
