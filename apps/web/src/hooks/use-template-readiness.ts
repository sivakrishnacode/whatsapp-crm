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
 * APP REQUIREMENTS ARE ONE QUESTION, NOT MANY
 *   Gmail, Calendar, Meet and Sheets all arrive through the workspace's
 *   single Apps Script bridge, so "is Google connected?" has one answer
 *   and one check: `GET /api/google-script`. The predecessor compared
 *   OAuth scopes per app, which died with the connector schema.
 */

import { useEffect, useMemo, useState } from 'react';

import { useChannelStatus } from '@/hooks/use-channel-status';
import {
  googleConnectionFromSummary,
  type GoogleScriptConnection,
  type GoogleScriptSummary,
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

export interface GoogleBridgeSnapshot {
  /** The bridge's connection status, or null before the fetch resolves. */
  google: GoogleScriptConnection | null;
  loading: boolean;
}

const CHANNEL_IDS = new Set(['whatsapp', 'instagram', 'web']);

/**
 * Bridge status, fetched once for the whole gallery.
 *
 * Two dozen cards resolving their own requirement would be two dozen
 * requests. Same reasoning as `ChannelStatusProvider`, at a smaller
 * scale — so this stays a hook the gallery calls once and passes down,
 * rather than a context nothing else needs.
 */
export function useGoogleBridgeSnapshot(): GoogleBridgeSnapshot {
  const [google, setGoogle] = useState<GoogleScriptConnection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/google-script', { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as {
            connection?: GoogleScriptSummary;
          };
          if (!cancelled) {
            setGoogle(googleConnectionFromSummary(json.connection));
          }
        }
      } catch {
        // Leave null — the gallery shows "checking" only while loading,
        // and a template that needs nothing else still works.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { google, loading };
}

export function resolveRequirements(
  template: AutomationTemplateDefinition,
  snapshot: GoogleBridgeSnapshot,
  channelStates: Record<string, { state: string }>
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
        ? {
            requirement,
            state: 'ready' as const,
            href: channelLandingHref(id as ChannelId),
          }
        : {
            requirement,
            state: 'missing' as const,
            href: channelConnectHref(id as ChannelId),
            detail: `Connect ${requirement.label} first — this automation only fires there.`,
          };
    }

    // kind === 'app' — the Google Apps Script bridge, the one and only.
    if (snapshot.loading) return { requirement, state: 'checking' as const };

    const connected =
      snapshot.google?.status === 'connected' ||
      snapshot.google?.status === 'error';
    const href = '/integrations';
    return connected
      ? { requirement, state: 'ready' as const, href }
      : {
          requirement,
          state: 'missing' as const,
          href,
          detail:
            'Set up the Google bridge in Integrations — Gmail, Calendar, Meet and Sheets all go through it.',
        };
  });
}

/** Requirements for one template, resolved against live workspace state. */
export function useTemplateReadiness(
  template: AutomationTemplateDefinition,
  snapshot: GoogleBridgeSnapshot
): ResolvedRequirement[] {
  const channelStates = useChannelStatus();
  return useMemo(
    () => resolveRequirements(template, snapshot, channelStates),
    [template, snapshot, channelStates]
  );
}
