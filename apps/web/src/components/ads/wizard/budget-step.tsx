'use client';

import { Clock, Info } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatMinor, toMinorUnits } from '@/lib/ads/types';
import type { ScheduleBlock, WizardState } from './wizard-state';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Coarse day-parting: 4-hour blocks rather than 24 per-hour cells. */
const HOUR_BLOCKS = [
  { label: '12–4am', start: 0, end: 240 },
  { label: '4–8am', start: 240, end: 480 },
  { label: '8am–12pm', start: 480, end: 720 },
  { label: '12–4pm', start: 720, end: 960 },
  { label: '4–8pm', start: 960, end: 1200 },
  { label: '8pm–12am', start: 1200, end: 1440 },
];

/**
 * Step 3 — budget and schedule.
 *
 * ⚠️ THE INPUT IS IN MAJOR UNITS; EVERYTHING DOWNSTREAM IS MINOR.
 *   The user types 500 meaning ₹500. `toMinorUnits` converts once, in the
 *   wizard's submit, and the API field is named `amountMinor` and typed as
 *   an integer. This component only ever shows the converted value back so
 *   the conversion is visible: "₹500.00" under a field containing "500".
 *
 * WHAT REPLACES THE REFERENCE'S CREDIT CHECK
 *   The reference product blocks here with "You don't have sufficient
 *   credit". We are not the payer, so the equivalent check is whether the
 *   customer's OWN ad account can spend — done at Setup and re-checked at
 *   publish. What this step enforces instead is the workspace's daily
 *   spend ceiling.
 */
export function BudgetStep({
  state,
  patch,
  currency,
  maxDailyBudgetMinor,
}: {
  state: WizardState;
  patch: (next: Partial<WizardState>) => void;
  currency: string | null;
  maxDailyBudgetMinor: number | null;
}) {
  const minor = toMinorUnits(state.budgetAmount);
  const scheduleOn = state.scheduleBlocks.length > 0;

  function toggleBlock(day: number, block: (typeof HOUR_BLOCKS)[number]) {
    const existing = state.scheduleBlocks.find(
      (b) =>
        b.start_minute === block.start &&
        b.end_minute === block.end &&
        b.days.includes(day),
    );

    if (existing) {
      const remainingDays = existing.days.filter((d) => d !== day);
      patch({
        scheduleBlocks: state.scheduleBlocks
          .map((b) => (b === existing ? { ...b, days: remainingDays } : b))
          .filter((b) => b.days.length > 0),
      });
      return;
    }

    // Merge into an existing block with the same hours rather than
    // appending a duplicate — Meta accepts either, but a schedule with 42
    // single-day entries is unreadable in Meta's own UI afterwards.
    const sameHours = state.scheduleBlocks.find(
      (b) => b.start_minute === block.start && b.end_minute === block.end,
    );

    if (sameHours) {
      patch({
        scheduleBlocks: state.scheduleBlocks.map((b) =>
          b === sameHours ? { ...b, days: [...b.days, day].sort() } : b,
        ),
      });
      return;
    }

    patch({
      scheduleBlocks: [
        ...state.scheduleBlocks,
        {
          days: [day],
          start_minute: block.start,
          end_minute: block.end,
        } satisfies ScheduleBlock,
      ],
    });
  }

  const isOn = (day: number, block: (typeof HOUR_BLOCKS)[number]) =>
    state.scheduleBlocks.some(
      (b) =>
        b.start_minute === block.start &&
        b.end_minute === block.end &&
        b.days.includes(day),
    );

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Budget type
          </span>
          <Select
            value={state.budgetMode}
            onValueChange={(next) => {
              if (next === 'daily' || next === 'lifetime') {
                patch({ budgetMode: next });
              }
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily budget</SelectItem>
              <SelectItem value="lifetime">Total budget</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Amount {currency ? `(${currency})` : ''}
          </span>
          <Input
            type="number"
            min={1}
            step="1"
            inputMode="decimal"
            value={state.budgetAmount}
            onChange={(e) => patch({ budgetAmount: e.target.value })}
            placeholder="500"
          />
          {/* The conversion, shown back. This is the guard against the
              units mistake: if "500" ever reads as ₹5.00, it is visible
              here before Publish. */}
          {minor > 0 ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              {state.budgetMode === 'daily' ? 'Per day' : 'Total'}:{' '}
              <span className="font-medium text-foreground tabular-nums">
                {formatMinor(minor, currency)}
              </span>
            </span>
          ) : null}
          {maxDailyBudgetMinor ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Workspace limit: {formatMinor(maxDailyBudgetMinor, currency)} per
              day.
            </span>
          ) : null}
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Start date
          </span>
          <Input
            type="date"
            value={state.startDate}
            onChange={(e) => patch({ startDate: e.target.value })}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Leave empty to start as soon as Meta approves the ad.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            End date{' '}
            {state.budgetMode === 'lifetime' ? (
              <span className="text-amber-600 dark:text-amber-500">
                (required)
              </span>
            ) : (
              <span className="text-muted-foreground">(optional)</span>
            )}
          </span>
          <Input
            type="date"
            value={state.endDate}
            onChange={(e) => patch({ endDate: e.target.value })}
          />
          {state.budgetMode === 'lifetime' ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              A total budget has to be spread over a fixed period, so Meta
              requires an end date.
            </span>
          ) : null}
        </label>
      </div>

      {/* Day-parting */}
      <div className="rounded-lg border border-border p-3">
        <label className="flex items-start justify-between gap-3">
          <span className="flex items-start gap-3">
            <Switch
              checked={scheduleOn}
              onCheckedChange={(on) =>
                patch({
                  scheduleBlocks: on
                    ? // Start from a sensible working-hours default rather
                      // than an empty grid, which reads as "the ad will
                      // never run".
                      [
                        {
                          days: [1, 2, 3, 4, 5],
                          start_minute: 480,
                          end_minute: 1200,
                        },
                      ]
                    : [],
                })
              }
            />
            <span>
              <span className="block text-sm text-foreground">
                Run on a custom schedule
              </span>
              <span className="block text-xs text-muted-foreground">
                Pick the hours the ad should run. Useful when enquiries need a
                human to answer them.
              </span>
            </span>
          </span>
          <Clock className="mt-1 size-4 shrink-0 text-muted-foreground" />
        </label>

        {scheduleOn ? (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] border-separate border-spacing-0.5 text-xs">
                <thead>
                  <tr>
                    <th className="w-14" />
                    {HOUR_BLOCKS.map((block) => (
                      <th
                        key={block.label}
                        className="pb-1 font-medium text-muted-foreground"
                      >
                        {block.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DAY_LABELS.map((label, day) => (
                    <tr key={label}>
                      <td className="pr-2 text-right text-muted-foreground">
                        {label}
                      </td>
                      {HOUR_BLOCKS.map((block) => {
                        const on = isOn(day, block);
                        return (
                          <td key={block.label}>
                            <button
                              type="button"
                              onClick={() => toggleBlock(day, block)}
                              aria-pressed={on}
                              aria-label={`${label} ${block.label}`}
                              className={cn(
                                'h-6 w-full rounded transition-colors',
                                on
                                  ? 'bg-primary'
                                  : 'bg-muted hover:bg-muted-foreground/20',
                              )}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Hours are in the ad account&apos;s timezone, which Meta fixes.
                Note that Meta may require a total budget for a custom
                schedule — if it refuses, switch the budget type above.
              </span>
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
