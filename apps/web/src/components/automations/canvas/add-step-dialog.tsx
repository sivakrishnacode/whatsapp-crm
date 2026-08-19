'use client';

/**
 * The step picker — a centred modal, not a dropdown.
 *
 * WHY A MODAL
 *   There are ~24 built-in steps plus a list of Google actions. A popover
 *   anchored to a button puts that in a 300px column at the edge of the
 *   screen, which is a scroll container, and a scroll container is where
 *   features go to be undiscovered. Centred, it gets the width for a
 *   category rail and a two-column grid, and it is where the eye already
 *   is.
 *
 * WHAT IT SHOWS, IN ORDER
 *   Search (typing beats browsing once you know the name) → categories →
 *   the steps in that category.
 *
 * TWO KINDS OF "APP", AND THE DIFFERENCE IS SHOWN, NOT HIDDEN
 *   GOOGLE ACTIONS come first: Google Sheets, Gmail, Calendar, Meet.
 *   Each ACTION is its own entry ("Google Sheets · Append row") because
 *   that is what somebody is looking for — nobody wants "an app", they
 *   want to append a row. Picking one adds a `google_action` step whose
 *   data flows through the Apps Script bridge.
 *
 *   PRESETS come second and are honestly labelled: they add an HTTP
 *   request step pre-filled for a service, and each says what key it
 *   will ask for BEFORE it is picked. Finding that out afterwards feels
 *   like a bait, which is the whole reason `credentialHint` exists.
 */

import { useMemo, useState } from 'react';
import { Ban, Search, X } from 'lucide-react';

import { googleServiceIcon } from '@/lib/automations/connectors';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  ADDABLE_STEPS,
  STEP_CATEGORIES,
  STEP_META,
  StepIconChip,
  type StepCategory,
} from '@/lib/automations/step-meta';
import { APP_PRESETS, type AppPreset } from '@/lib/automations/app-presets';
import { stepAvailability } from '@/lib/automations/availability';
import type { GoogleScriptAction } from '@/lib/automations/connectors';
import { useAutomationResources } from './resources';
import type { AutomationStepType, AutomationTriggerType } from '@/types';

type RailId = StepCategory | 'all' | 'apps';

export interface AddStepDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A built-in step. */
  onPickStep: (type: AutomationStepType) => void;
  /** An app preset — an HTTP step with its config pre-filled. */
  onPickApp: (preset: AppPreset) => void;
  /** A Google action — adds a `google_action` step. */
  onPickAction: (action: GoogleScriptAction) => void;
  channels: string[];
  triggerType: AutomationTriggerType;
}

export function AddStepDialog({
  open,
  onOpenChange,
  onPickStep,
  onPickApp,
  onPickAction,
  channels,
  triggerType,
}: AddStepDialogProps) {
  const { googleActions, googleServiceLabels, googleConnection } =
    useAutomationResources();
  const [rail, setRail] = useState<RailId>('all');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const steps = useMemo(() => {
    return ADDABLE_STEPS.filter((type) => {
      const meta = STEP_META[type];
      if (!meta) return false;
      if (q) {
        return (
          meta.label.toLowerCase().includes(q) ||
          meta.blurb.toLowerCase().includes(q) ||
          type.includes(q)
        );
      }
      return rail === 'all' || meta.category === rail;
    });
  }, [rail, q]);

  /**
   * Every action from the Google Script bridge catalogue, flattened.
   *
   * Flattened rather than grouped by service because the list is short
   * and the thing being chosen is an action.
   */
  const actions = useMemo(() => {
    if (q) {
      return googleActions.filter(
        (action) =>
          action.label.toLowerCase().includes(q) ||
          action.description.toLowerCase().includes(q) ||
          (googleServiceLabels[action.service] ?? action.service)
            .toLowerCase()
            .includes(q)
      );
    }
    return rail === 'all' || rail === 'apps' ? googleActions : [];
  }, [googleActions, googleServiceLabels, rail, q]);

  const apps = useMemo(() => {
    if (q) {
      return APP_PRESETS.filter(
        (a) =>
          a.name.toLowerCase().includes(q) || a.blurb.toLowerCase().includes(q)
      );
    }
    return rail === 'all' || rail === 'apps' ? APP_PRESETS : [];
  }, [rail, q]);

  const close = () => {
    onOpenChange(false);
    setQuery('');
    setRail('all');
  };

  const bridgeConnected =
    googleConnection?.status === 'connected' ||
    googleConnection?.status === 'error';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[560px] max-h-[85vh] w-[min(920px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <div className="border-border flex items-center gap-2 border-b px-4 py-3">
          <Search size={15} className="text-muted-foreground shrink-0" />
          <DialogTitle className="sr-only">Add a step</DialogTitle>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search steps and apps…"
            aria-label="Search steps and apps"
            className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
          />
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Step categories"
            className="border-border w-[168px] shrink-0 overflow-y-auto border-r py-2"
          >
            {(
              [
                { id: 'all' as const, label: 'All' },
                ...STEP_CATEGORIES,
                { id: 'apps' as const, label: 'Apps' },
              ] satisfies { id: RailId; label: string }[]
            ).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setRail(c.id);
                  setQuery('');
                }}
                aria-current={rail === c.id && !q ? 'true' : undefined}
                className={cn(
                  'w-full px-4 py-1.5 text-left text-[13px] transition-colors',
                  rail === c.id && !q
                    ? 'bg-muted text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {c.label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain p-3">
            {steps.length === 0 &&
              apps.length === 0 &&
              actions.length === 0 && (
                <p className="text-muted-foreground px-3 py-10 text-center text-sm">
                  Nothing called &ldquo;{query}&rdquo;.
                </p>
              )}

            {steps.length > 0 && (
              <>
                <SectionLabel>Steps</SectionLabel>
                <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                  {steps.map((type) => {
                    const meta = STEP_META[type];
                    const availability = stepAvailability(
                      type,
                      channels,
                      triggerType
                    );
                    const unusable = availability.status === 'never';
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          onPickStep(type);
                          close();
                        }}
                        className={cn(
                          'hover:bg-muted flex items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors',
                          unusable && 'opacity-55'
                        )}
                      >
                        <StepIconChip
                          type={type}
                          size={30}
                          iconSize={15}
                          className="mt-0.5 rounded-lg"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground flex items-center gap-1.5 text-[13px] font-medium">
                            {meta.label}
                            {unusable && (
                              <span className="text-destructive flex items-center gap-0.5 text-[9.5px] tracking-wide uppercase">
                                <Ban size={10} />
                                won&apos;t run here
                              </span>
                            )}
                          </span>
                          <span className="text-muted-foreground block text-[11.5px] leading-snug">
                            {unusable ? availability.reason : meta.blurb}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {actions.length > 0 && (
              <>
                <SectionLabel>
                  Google
                  <span className="text-muted-foreground ml-2 text-[10.5px] normal-case">
                    via Apps Script bridge — one setup, all services
                  </span>
                </SectionLabel>
                <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                  {actions.map((action) => {
                    const serviceName =
                      googleServiceLabels[action.service] ?? action.service;
                    return (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => {
                          onPickAction(action);
                          close();
                        }}
                        className="hover:bg-muted flex items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors"
                      >
                        {/* The product logo, not a generic bolt: this
                            list is scanned by icon, and "Sheets" next to
                            "Gmail" is recognised long before it is read. */}
                        <div className="bg-muted/60 mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-lg">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={googleServiceIcon(action.service)}
                            alt=""
                            aria-hidden
                            className="size-[17px] object-contain"
                          />
                        </div>
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground flex items-center gap-1.5 text-[13px] font-medium">
                            {serviceName} · {action.label}
                            {!bridgeConnected && (
                              <span className="text-muted-foreground text-[9.5px] tracking-wide uppercase">
                                set up first
                              </span>
                            )}
                          </span>
                          <span className="text-muted-foreground block text-[11.5px] leading-snug">
                            {action.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {apps.length > 0 && (
              <>
                <SectionLabel>
                  Other services
                  <span className="text-muted-foreground ml-2 text-[10.5px] normal-case">
                    each one adds an HTTP request step, pre-filled — you supply
                    the key
                  </span>
                </SectionLabel>
                <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                  {apps.map((app) => (
                    <button
                      key={app.id}
                      type="button"
                      onClick={() => {
                        onPickApp(app);
                        close();
                      }}
                      className="hover:bg-muted flex items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors"
                    >
                      <span
                        className="mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
                        style={{ background: app.hue }}
                        aria-hidden
                      >
                        {app.monogram}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground text-[13px] font-medium">
                          {app.name}
                        </span>
                        <span className="text-muted-foreground block text-[11.5px] leading-snug">
                          {app.blurb}
                          {app.credentialHint && (
                            <span className="text-muted-foreground/60 ml-1">
                              — needs {app.credentialHint}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground mt-3 mb-1 px-1 text-[10.5px] font-semibold tracking-wider uppercase first:mt-0">
      {children}
    </h3>
  );
}
