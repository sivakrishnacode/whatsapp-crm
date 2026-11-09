'use server';

import { Prisma } from '@prisma/client';
import { refresh } from 'next/cache';

import { recordAudit } from '@/lib/actions/audit';
import { FieldError, integer, oneOf } from '@/lib/actions/parse';
import type { ActionState } from '@/lib/actions/subscriptions';
import { authorizeAction } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  parseSettings,
  type ControlCenterSettings,
  type Severity,
} from '@/lib/settings';
import { getSettings } from '@/lib/settings-store';

/**
 * System Settings writes (Super Admin only).
 *
 * Validation is the same `parseSettings` every reader uses, run over the
 * submitted values BEFORE anything is written: if the parser would have
 * replaced a value with its default (out of range, incoherent), the form is
 * refused with a sentence instead of saving something the rest of the panel
 * would silently ignore.
 *
 * SLA targets apply to tickets created (or re-graded) after the change —
 * due times are written onto each ticket at creation, so moving a target
 * never rewrites the clocks of tickets already open. The form says so.
 */

const SEVERITIES: Severity[] = ['critical', 'high', 'normal', 'low'];

export async function updateSettings(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('settings.manage');
  if (auth.error) return { error: auth.error };
  const staff = auth.staff;

  try {
    const sla = Object.fromEntries(
      SEVERITIES.map((severity) => {
        const first = integer(formData, `sla.${severity}.first`, {
          label: `${severity} first response (minutes)`,
          min: 1,
          max: 60 * 24 * 30,
        })!;
        const resolve = integer(formData, `sla.${severity}.resolve`, {
          label: `${severity} resolution (minutes)`,
          min: 1,
          max: 60 * 24 * 90,
        })!;
        if (resolve < first) {
          throw new FieldError(
            `The ${severity} resolution target must not be shorter than its first-response target.`
          );
        }
        return [
          severity,
          { firstResponseMinutes: first, resolutionMinutes: resolve },
        ];
      })
    ) as ControlCenterSettings['sla'];

    const windowRaw = oneOf(
      formData,
      'renewalWindowDays',
      ['7', '15', '30'] as const,
      {
        label: 'Renewal window',
      }
    )!;
    const attention = integer(formData, 'deliveryAttentionPct', {
      label: 'Delivery attention %',
      min: 1,
      max: 100,
    })!;
    const critical = integer(formData, 'deliveryCriticalPct', {
      label: 'Delivery critical %',
      min: 1,
      max: 100,
    })!;
    if (critical < attention) {
      throw new FieldError(
        'The critical failure rate must be at least the attention rate.'
      );
    }

    const next: ControlCenterSettings = {
      sla,
      renewalWindowDays: Number(windowRaw) as 7 | 15 | 30,
      healthStaleHours: integer(formData, 'healthStaleHours', {
        label: 'Health staleness (hours)',
        min: 1,
        max: 24 * 30,
      })!,
      lowCreditThreshold: integer(formData, 'lowCreditThreshold', {
        label: 'Low credit threshold',
        min: 1,
        max: 1_000_000,
      })!,
      stalledOnboardingDays: integer(formData, 'stalledOnboardingDays', {
        label: 'Stalled onboarding (days)',
        min: 1,
        max: 365,
      })!,
      inactiveClientDays: integer(formData, 'inactiveClientDays', {
        label: 'Inactive client (days)',
        min: 1,
        max: 365,
      })!,
      deliveryAttentionPct: attention,
      deliveryCriticalPct: critical,
    };

    // Round-trip through the reader's parser: what we store must read back
    // as exactly what was submitted.
    const rows = Object.entries(next).map(([key, value]) => ({ key, value }));
    const reparsed = parseSettings(rows);
    if (JSON.stringify(reparsed) !== JSON.stringify(next)) {
      throw new FieldError(
        'One of the values is outside what the Control Center accepts.'
      );
    }

    const before = await getSettings();
    const changed = (
      Object.keys(next) as (keyof ControlCenterSettings)[]
    ).filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(next[key])
    );
    if (changed.length === 0) return { ok: 'Nothing changed.' };

    await prisma.$transaction(
      changed.map((key) =>
        prisma.admin_settings.upsert({
          where: { key },
          create: {
            key,
            value: next[key] as unknown as Prisma.InputJsonValue,
            updated_by: staff.actor,
          },
          update: {
            value: next[key] as unknown as Prisma.InputJsonValue,
            updated_by: staff.actor,
            updated_at: new Date(),
          },
        })
      )
    );

    await recordAudit({
      actor: staff.actor,
      action: 'settings.update',
      targetType: 'settings',
      summary: `Changed Control Center settings: ${changed.join(', ')}.`,
      detail: Object.fromEntries(
        changed.map((key) => [key, { before: before[key], after: next[key] }])
      ),
    });

    refresh();
    return {
      ok: `Saved ${changed.length} setting${changed.length === 1 ? '' : 's'}.`,
    };
  } catch (error) {
    if (error instanceof FieldError) return { error: error.message };
    console.error('[admin-panel] settings update failed', error);
    return { error: 'Could not save the settings. Check the logs.' };
  }
}
