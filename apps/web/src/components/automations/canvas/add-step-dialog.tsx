'use client';

/**
 * The step picker — a centred modal, not a dropdown.
 *
 * WHY A MODAL
 *   There are ~24 built-in steps plus a list of apps. A popover anchored
 *   to a button puts that in a 300px column at the edge of the screen,
 *   which is a scroll container, and a scroll container is where features
 *   go to be undiscovered. Centred, it gets the width for a category rail
 *   and a two-column grid, and it is where the eye already is.
 *
 * WHAT IT SHOWS, IN ORDER
 *   Search (typing beats browsing once you know the name) → categories →
 *   the steps in that category.
 *
 * TWO KINDS OF "APP", AND THE DIFFERENCE IS SHOWN, NOT HIDDEN
 *   CONNECTED APPS come first: Google Sheets, Gmail, Calendar, Meet.
 *   Each ACTION is its own entry ("Google Sheets · Append row") because
 *   that is what somebody is looking for — nobody wants "an app", they
 *   want to append a row. Picking one adds an `app_action` step whose
 *   credentials are an OAuth connection nobody has to paste.
 *
 *   PRESETS come second and are honestly labelled: they add an HTTP
 *   request step pre-filled for a service, and each says what key it
 *   will ask for BEFORE it is picked. Finding that out afterwards feels
 *   like a bait, which is the whole reason `credentialHint` exists.
 */

import { useMemo, useState } from 'react';
import { Ban, Search, X } from 'lucide-react';

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
import {
  connectionsFor,
  missingScopes,
  type CatalogAction,
  type CatalogApp,
} from '@/lib/automations/connectors';
import { useAutomationResources } from './resources';
import { AppIcon } from '@/components/integrations/app-icon';
import type { AutomationStepType, AutomationTriggerType } from '@/types';

type RailId = StepCategory | 'all' | 'apps';

export interface AddStepDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A built-in step. */
  onPickStep: (type: AutomationStepType) => void;
  /** An app preset — an HTTP step with its config pre-filled. */
  onPickApp: (preset: AppPreset) => void;
  /** A real connector action — adds an `app_action` step. */
  onPickAction: (app: CatalogApp, action: CatalogAction) => void;
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
  const { apps: catalog, connections } = useAutomationResources();
  const [rail, setRail] = useState<RailId>('all');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const steps = useMemo(() => {
    return ADDABLE_STEPS.filter((type) => {
      const meta = STEP_META[type];
      if (!meta) return false;
      // Search ignores the rail: somebody typing "webhook" wants the
      // webhook step, not to be told it lives under a bucket they did
      // not click.
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
   * Every action of every connected app, flattened.
   *
   * Flattened rather than grouped by app because the list is short and
   * the thing being chosen is an action. Grouping would add a level of
   * clicking to reach the only leaf anyone wants.
   */
  const actions = useMemo(() => {
    const all = catalog.flatMap((app) =>
      app.actions.map((action) => ({ app, action })),
    );
    if (q) {
      return all.filter(
        ({ app, action }) =>
          app.name.toLowerCase().includes(q) ||
          action.label.toLowerCase().includes(q) ||
          action.description.toLowerCase().includes(q),
      );
    }
    return rail === 'all' || rail === 'apps' ? all : [];
  }, [catalog, rail, q]);

  const apps = useMemo(() => {
    if (q) {
      return APP_PRESETS.filter(
        (a) =>
          a.name.toLowerCase().includes(q) || a.blurb.toLowerCase().includes(q),
      );
    }
    return rail === 'all' || rail === 'apps' ? APP_PRESETS : [];
  }, [rail, q]);

  const close = () => {
    onOpenChange(false);
    setQuery('');
    setRail('all');
  };

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
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {c.label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain p-3">
            {steps.length === 0 && apps.length === 0 && actions.length === 0 && (
              <p className="text-muted-foreground px-3 py-10 text-center text-sm">
                Nothing called “{query}”.
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
                      triggerType,
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
                          // Dimmed WITH a reason, never hidden: a step
                          // missing from a menu reads as a bug.
                          unusable && 'opacity-55',
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
                                won’t run here
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
                  Connected apps
                  <span className="text-muted-foreground ml-2 text-[10.5px] normal-case">
                    sign in once — no keys to paste
                  </span>
                </SectionLabel>
                <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                  {actions.map(({ app, action }) => {
                    // Per ACTION, not per provider: one Google connection
                    // covers all four Google cards, but only with the
                    // scopes actually granted. A Sheets-only grant must
                    // not present "Gmail · Send email" as ready to run.
                    const connected = connectionsFor(connections, app).some(
                      (c) =>
                        c.status === 'active' &&
                        missingScopes(c, action).length === 0,
                    );
                    return (
                      <button
                        key={`${app.app}:${action.id}`}
                        type="button"
                        onClick={() => {
                          onPickAction(app, action);
                          close();
                        }}
                        className="hover:bg-muted flex items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors"
                      >
                        <AppIcon
                          app={app}
                          size={30}
                          className="mt-0.5 rounded-lg"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground flex items-center gap-1.5 text-[13px] font-medium">
                            {app.name} · {action.label}
                            {/* Not connected is shown but never blocks the
                                pick: adding the step then connecting is a
                                perfectly reasonable order, and the
                                inspector offers the Connect button. */}
                            {!connected && (
                              <span className="text-muted-foreground text-[9.5px] tracking-wide uppercase">
                                connect first
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
                    each one adds an HTTP request step, pre-filled — you
                    supply the key
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
                        className="mt-0.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[10px] font-bold"
                        style={{
                          background: `color-mix(in oklch, ${app.hue} 16%, transparent)`,
                          color: `color-mix(in oklch, ${app.hue}, var(--foreground) 22%)`,
                        }}
                        aria-hidden
                      >
                        {app.monogram}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block text-[13px] font-medium">
                          {app.name}
                        </span>
                        <span className="text-muted-foreground block text-[11.5px] leading-snug">
                          {app.blurb}
                        </span>
                        {/* Said before the pick, not after: this is the
                            difference between a preset and a connector,
                            and finding out later feels like a bait. */}
                        <span className="text-muted-foreground/80 mt-0.5 block text-[10.5px] leading-snug italic">
                          {app.credentialHint}
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
    <div className="text-muted-foreground px-3 pt-2 pb-1.5 text-[10.5px] font-semibold tracking-wider uppercase">
      {children}
    </div>
  );
}
