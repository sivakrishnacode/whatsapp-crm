'use client';

/**
 * Can this template actually run in THIS workspace, today?
 *
 * WHY THE GALLERY ANSWERS THIS AT ALL
 *   A template is a promise. "Log every lead to Google Sheets" that
 *   silently does nothing because nobody connected Google is worse than
 *   no template, because the failure is invisible: the automation saves,
 *   activates, and the sheet just stays empty. Declaring the requirement
 *   on the card turns that into a sentence somebody reads BEFORE they
 *   pick it.
 *
 * THREE ANSWERS, MIRRORING THE THREE REQUIREMENT KINDS
 *   `ready`   — checked live and satisfied.
 *   `missing` — checked live and not satisfied. Carries an `href` to the
 *               one place that fixes it.
 *   `manual`  — cannot be checked from here and does not need to be: a
 *               tag, a pipeline stage, a form. The author picks it in the
 *               builder, where the pickers and the diagnostics live.
 *
 * `manual` is deliberately NOT rendered as a warning. Every second
 * template needs a tag, and a badge that is always red is a badge nobody
 * reads — the same reasoning as `availability.ts` refusing to warn about
 * partial channel support on unscoped automations.
 *
 * APP REQUIREMENTS ARE CHECKED BY SCOPE, NOT BY PROVIDER
 *   "Has a Google connection" is not the question — Gmail send and
 *   Sheets append are different scopes, and incremental consent means a
 *   workspace can genuinely have one and not the other. The check reads
 *   the SCOPES the template's own `app_action` steps need out of the
 *   served catalogue and compares them against the connection, using the
 *   same `missingScopes()` the step inspector uses.
 */

import { useEffect, useMemo, useState } from 'react';

import { useChannelStatus } from '@/hooks/use-channel-status';
import {
  connectUrl,
  findAction,
  findApp,
  type AppConnection,
  type CatalogApp,
} from '@/lib/automations/connectors';
import {
  templateRequirements,
  type AutomationTemplateDefinition,
  type TemplateRequirement,
} from '@/lib/automations/templates';
import { channelConnectHref, channelLandingHref } from '@/lib/nav/channels';
import type { ChannelId } from '@/lib/nav/channels';

export type RequirementState = 'ready' | 'missing' | 'manual' | 'checking';

export interface ResolvedRequirement {
  requirement: TemplateRequirement;
  state: RequirementState;
  /** Where to go to satisfy it. Absent for `manual`. */
  href?: string;
  /** One sentence, written for the person who has to fix it. */
  detail?: string;
}

export interface ConnectionsSnapshot {
  connections: AppConnection[];
  apps: CatalogApp[];
  loading: boolean;
}

const CHANNEL_IDS = new Set(['whatsapp', 'instagram', 'web']);

/**
 * Connections + catalogue, fetched once for the whole gallery.
 *
 * Two dozen cards resolving their own requirements would be two dozen
 * pairs of requests. Same reasoning as `ChannelStatusProvider`, at a
 * smaller scale — so this stays a hook the gallery calls once and passes
 * down, rather than a context nothing else needs.
 */
export function useConnectionsSnapshot(): ConnectionsSnapshot {
  const [connections, setConnections] = useState<AppConnection[]>([]);
  const [apps, setApps] = useState<CatalogApp[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, catalog] = await Promise.allSettled([
        fetch('/api/connections', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/connections/catalog', { cache: 'no-store' }).then((r) =>
          r.json(),
        ),
      ]);
      if (cancelled) return;
      if (list.status === 'fulfilled') {
        setConnections((list.value?.connections ?? []) as AppConnection[]);
      }
      if (catalog.status === 'fulfilled') {
        setApps((catalog.value?.apps ?? []) as CatalogApp[]);
      }
      // Loading ends either way. A gallery stuck on "checking…" because
      // one endpoint 500'd tells the user nothing and hides the
      // templates that need no connection at all.
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { connections, apps, loading };
}

/** Which app actions a template's steps actually invoke. */
function appActionsIn(
  template: AutomationTemplateDefinition,
): { app: string; action: string }[] {
  const out: { app: string; action: string }[] = [];
  for (const seed of template.steps) {
    if (seed.step_type !== 'app_action') continue;
    const cfg = seed.step_config as { app?: string; action?: string };
    if (cfg.app && cfg.action) out.push({ app: cfg.app, action: cfg.action });
  }
  return out;
}

export function resolveRequirements(
  template: AutomationTemplateDefinition,
  snapshot: ConnectionsSnapshot,
  channelStates: Record<string, { state: string }>,
  returnTo: string,
): ResolvedRequirement[] {
  return templateRequirements(template).map((requirement) => {
    if (requirement.kind === 'setup') {
      return {
        requirement,
        state: 'manual' as const,
        detail: `You'll choose this in the builder.`,
      };
    }

    if (requirement.kind === 'channel') {
      const id = requirement.id;
      const status = CHANNEL_IDS.has(id) ? channelStates[id] : undefined;
      if (!status || status.state === 'loading') {
        return { requirement, state: 'checking' as const };
      }
      // Two different destinations for two different situations: a
      // connected channel opens on its analytics overview, an
      // unconnected one goes straight to the settings screen that has
      // the connect button. They were one href only because the
      // landing page used to BE Channel Settings.
      return status.state === 'connected'
        ? { requirement, state: 'ready' as const, href: channelLandingHref(id as ChannelId) }
        : {
            requirement,
            state: 'missing' as const,
            href: channelConnectHref(id as ChannelId),
            detail: `Connect ${requirement.label} first — this automation only fires there.`,
          };
    }

    // kind === 'app'
    if (snapshot.loading) return { requirement, state: 'checking' as const };

    const app = findApp(snapshot.apps, requirement.app);
    if (!app) {
      // The catalogue is the authority on what exists. If it does not
      // list the app, saying "not connected" would send someone to an
      // OAuth flow that isn't there.
      return {
        requirement,
        state: 'missing' as const,
        detail: `${requirement.label} is not available on this workspace.`,
      };
    }

    const needed = appActionsIn(template)
      .filter((a) => a.app === requirement.app)
      .flatMap((a) => findAction(app, a.action)?.scopes ?? []);

    // Same comparison as `missingScopes()` in connectors.ts, but across
    // the union of every action this template calls rather than one —
    // a template with a Sheets step and a Gmail step needs both.
    const satisfied = snapshot.connections.some(
      (c) =>
        c.provider === requirement.provider &&
        c.status === 'active' &&
        needed.every((scope) => c.scopes.includes(scope)),
    );

    const href = connectUrl(app, returnTo);
    return satisfied
      ? { requirement, state: 'ready' as const, href }
      : {
          requirement,
          state: 'missing' as const,
          href,
          detail: `Connect ${requirement.label} to let this automation write to it.`,
        };
  });
}

/** Requirements for one template, resolved against live workspace state. */
export function useTemplateReadiness(
  template: AutomationTemplateDefinition,
  snapshot: ConnectionsSnapshot,
  returnTo: string,
): ResolvedRequirement[] {
  const channelStates = useChannelStatus();
  return useMemo(
    () => resolveRequirements(template, snapshot, channelStates, returnTo),
    [template, snapshot, channelStates, returnTo],
  );
}
