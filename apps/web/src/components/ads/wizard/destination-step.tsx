'use client';

import {
  Check,
  FileText,
  Globe,
  Info,
  MessageCircle,
  Radio,
} from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  SPECIAL_AD_CATEGORY_LABELS,
  type AdType,
  type AdTypeCatalogue,
  type AdTypeInfo,
} from '@/lib/ads/types';
import type { WizardState } from './wizard-state';

/** One icon per destination, matching the reference's card row. */
const TYPE_ICONS: Record<AdType, React.ComponentType<{ className?: string }>> = {
  click_to_whatsapp: MessageCircle,
  whatsapp_status: Radio,
  website_to_whatsapp: Globe,
  website: Globe,
  lead_form: FileText,
};

/**
 * Step 1 — destination, objective and performance goal.
 *
 * The objective is shown read-only. It is derived from the destination by
 * the builder and is not a user choice: the objective / destination /
 * optimisation-goal triple is what Meta rejects most often, and offering
 * a free choice of objective is how you build an invalid combination.
 */
export function DestinationStep({
  catalogue,
  state,
  patch,
  selectedType,
}: {
  catalogue: AdTypeCatalogue;
  state: WizardState;
  patch: (next: Partial<WizardState>) => void;
  selectedType: AdTypeInfo | null;
}) {
  function chooseType(type: AdTypeInfo) {
    if (type.unavailableReason) return;

    patch({
      adType: type.id,
      // Reset the goal to this type's default rather than keeping the
      // previous type's — a goal from another type would be rejected at
      // publish, four Graph calls in.
      optimizationGoal:
        type.performanceGoals.find((g) => g.isDefault)?.value ??
        type.performanceGoals[0]?.value ??
        '',
      // Same for the CTA, whose valid set is per-type.
      callToAction: type.callToActions[0]?.value ?? '',
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {catalogue.adTypes.map((type) => {
          const Icon = TYPE_ICONS[type.id];
          const selected = state.adType === type.id;
          const disabled = Boolean(type.unavailableReason);

          return (
            <button
              key={type.id}
              type="button"
              onClick={() => chooseType(type)}
              disabled={disabled}
              aria-pressed={selected}
              className={cn(
                'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                selected
                  ? 'border-primary bg-primary-soft'
                  : 'border-border bg-card hover:border-border/80',
                disabled && 'cursor-not-allowed opacity-60 hover:border-border',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
                  selected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-foreground">
                    {type.label}
                  </span>
                  {selected ? (
                    <Check className="size-3.5 shrink-0 text-primary" />
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {type.description}
                </span>
                {/* Never a bare "unavailable" — the reason is the only
                    actionable part. */}
                {type.unavailableReason ? (
                  <span className="mt-1.5 block text-xs text-accent-amber">
                    {type.unavailableReason}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      {selectedType ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Campaign name
              </span>
              <Input
                value={state.campaignName}
                onChange={(e) => patch({ campaignName: e.target.value })}
                placeholder="Monsoon sale — enquiries"
                maxLength={255}
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Performance goal
              </span>
              <Select
                value={state.optimizationGoal || null}
                onValueChange={(next) => {
                  if (typeof next === 'string') {
                    patch({ optimizationGoal: next });
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a goal" />
                </SelectTrigger>
                <SelectContent>
                  {selectedType.performanceGoals.map((goal) => (
                    <SelectItem key={goal.value} value={goal.value}>
                      {goal.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* The description is where the real decision is made, so it
                  is always visible rather than hidden in a tooltip. */}
              <span className="mt-1.5 block text-xs text-muted-foreground">
                {
                  selectedType.performanceGoals.find(
                    (g) => g.value === state.optimizationGoal,
                  )?.description
                }
              </span>
            </label>
          </div>

          <div className="rounded-lg bg-muted/40 px-3 py-2.5">
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Campaign objective:{' '}
                <span className="font-medium text-foreground">
                  {selectedType.objective.replace('OUTCOME_', '')}
                </span>
                . Set automatically from the destination — the objective,
                destination and goal have to be a combination Meta accepts.
              </span>
            </p>
          </div>

          {/* Special ad categories. An explicit question, never a silent
              default: these carry legal targeting restrictions, and
              defaulting them to "none" would answer on the user's behalf. */}
          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-xs font-medium text-foreground">
              Is this ad about any of these?
            </legend>
            <p className="mb-2 text-xs text-muted-foreground">
              Meta restricts targeting for these categories by law. Leave all
              unticked if none apply.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {catalogue.specialAdCategories.map((category) => {
                const checked = state.specialAdCategories.includes(category);
                return (
                  <label
                    key={category}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) =>
                        patch({
                          specialAdCategories: next
                            ? [...state.specialAdCategories, category]
                            : state.specialAdCategories.filter(
                                (c) => c !== category,
                              ),
                        })
                      }
                    />
                    {SPECIAL_AD_CATEGORY_LABELS[category] ?? category}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </>
      ) : null}
    </div>
  );
}
