'use client';

import { useActionState } from 'react';

import { Field, FormMessage, Input, Select } from '@/components/ui/form';
import { SubmitButton } from '@/components/ui/submit-button';
import { updateSettings } from '@/lib/actions/settings';
import type { ActionState } from '@/lib/actions/subscriptions';
import type { ControlCenterSettings } from '@/lib/settings';

const SEVERITY_LABEL = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
} as const;

function readable(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 48) return `${+(minutes / 60).toFixed(1)} h`;
  return `${+(minutes / 1440).toFixed(1)} days`;
}

/**
 * Every value is entered in the unit its label names — SLA targets in
 * MINUTES — and the current value is echoed in human units beside it, so
 * "1440" is never mistaken for hours.
 */
export function SettingsForm({ current }: { current: ControlCenterSettings }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateSettings,
    {}
  );

  return (
    <form action={formAction} className="space-y-8">
      <fieldset className="space-y-3">
        <legend className="text-ink text-sm font-semibold">
          Support SLA targets
        </legend>
        <p className="text-muted text-xs leading-relaxed">
          In minutes, 24×7 (the clock does not pause for business hours or while
          waiting on the customer). Due times are stamped on a ticket when it is
          created or re-graded, so a change here applies to new tickets only.
        </p>
        <div className="border-ring overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[32rem] text-sm">
            <thead className="bg-surface-2 text-muted text-[11px] font-semibold tracking-wide uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Severity</th>
                <th className="px-4 py-2 text-left">First response (min)</th>
                <th className="px-4 py-2 text-left">Resolution (min)</th>
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {(['critical', 'high', 'normal', 'low'] as const).map(
                (severity) => (
                  <tr key={severity}>
                    <td className="text-ink px-4 py-2 font-semibold">
                      {SEVERITY_LABEL[severity]}
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        type="number"
                        name={`sla.${severity}.first`}
                        defaultValue={
                          current.sla[severity].firstResponseMinutes
                        }
                        min={1}
                        max={43200}
                        required
                        aria-label={`${SEVERITY_LABEL[severity]} first response in minutes`}
                        className="w-28"
                      />
                      <span className="text-muted ml-2 text-xs">
                        now{' '}
                        {readable(current.sla[severity].firstResponseMinutes)}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        type="number"
                        name={`sla.${severity}.resolve`}
                        defaultValue={current.sla[severity].resolutionMinutes}
                        min={1}
                        max={129600}
                        required
                        aria-label={`${SEVERITY_LABEL[severity]} resolution in minutes`}
                        className="w-28"
                      />
                      <span className="text-muted ml-2 text-xs">
                        now {readable(current.sla[severity].resolutionMinutes)}
                      </span>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="text-ink mb-3 text-sm font-semibold sm:col-span-2 lg:col-span-3">
          Watch windows and thresholds
        </legend>
        <Field
          label="Renewal watchlist window"
          hint="The default on Subscriptions → Renewals."
        >
          <Select
            name="renewalWindowDays"
            defaultValue={String(current.renewalWindowDays)}
          >
            <option value="7">7 days</option>
            <option value="15">15 days</option>
            <option value="30">30 days</option>
          </Select>
        </Field>
        <Field
          label="Health evidence goes stale after (hours)"
          hint="Older evidence grades Unknown, never Healthy. The API syncs quality every 6 h."
        >
          <Input
            type="number"
            name="healthStaleHours"
            defaultValue={current.healthStaleHours}
            min={1}
            max={720}
            required
          />
        </Field>
        <Field
          label="Low AI credit threshold (credits)"
          hint="Platform wallets at or below this are flagged."
        >
          <Input
            type="number"
            name="lowCreditThreshold"
            defaultValue={current.lowCreditThreshold}
            min={1}
            required
          />
        </Field>
        <Field
          label="Onboarding stalls after (days)"
          hint="Days in one stage before the queue flags it."
        >
          <Input
            type="number"
            name="stalledOnboardingDays"
            defaultValue={current.stalledOnboardingDays}
            min={1}
            max={365}
            required
          />
        </Field>
        <Field
          label="Client inactive after (days)"
          hint="Days without a message before a live client counts as inactive."
        >
          <Input
            type="number"
            name="inactiveClientDays"
            defaultValue={current.inactiveClientDays}
            min={1}
            max={365}
            required
          />
        </Field>
        <div />
        <Field
          label="Delivery failure → Attention (%)"
          hint="7-day outbound failure rate."
        >
          <Input
            type="number"
            name="deliveryAttentionPct"
            defaultValue={current.deliveryAttentionPct}
            min={1}
            max={100}
            required
          />
        </Field>
        <Field
          label="Delivery failure → Critical (%)"
          hint="Must be at least the attention rate."
        >
          <Input
            type="number"
            name="deliveryCriticalPct"
            defaultValue={current.deliveryCriticalPct}
            min={1}
            max={100}
            required
          />
        </Field>
      </fieldset>

      <FormMessage ok={state.ok} error={state.error} />
      <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
    </form>
  );
}
