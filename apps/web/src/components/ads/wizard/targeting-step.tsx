'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Loader2, MapPin, Search, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import {
  FACEBOOK_POSITIONS,
  INSTAGRAM_POSITIONS,
  formatCompact,
  type AdAudience,
  type GeoResult,
  type TargetingCategory,
} from '@/lib/ads/types';
import type { WizardState } from './wizard-state';

/** Category → chip colour, matching the reference's colour-coded chips. */
const CATEGORY_TONE: Record<string, string> = {
  interests: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  demographics:
    'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  behaviors:
    'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
};

/**
 * Step 2 — audience and placements.
 *
 * ⚠️ A SAVED AUDIENCE DISABLES THE HAND-BUILT FIELDS, VISIBLY.
 *   Meta rejects `saved_audience_id` combined with geo/age/interest
 *   targeting, so `buildTargeting` drops those fields when a saved
 *   audience is chosen. If the form still showed them as editable, the
 *   user would carefully set an age range that is then silently discarded.
 *   So the fields grey out and say why.
 */
export function TargetingStep({
  state,
  patch,
}: {
  state: WizardState;
  patch: (next: Partial<WizardState>) => void;
}) {
  const [audiences, setAudiences] = useState<{
    custom: AdAudience[];
    saved: Array<{ id: string; name: string }>;
  } | null>(null);
  const [savingAudience, setSavingAudience] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/ads/audiences', { cache: 'no-store' });
        if (res.ok) {
          setAudiences(
            (await res.json()) as {
              custom: AdAudience[];
              saved: Array<{ id: string; name: string }>;
            },
          );
        }
      } catch {
        // Audiences are optional; the rest of the step works without them.
      }
    })();
  }, []);

  const savedLocked = Boolean(state.savedAudienceId);

  /**
   * Store the targeting built above so it can be reused on the next ad.
   *
   * Sends the wizard's own shape; the API runs it through the same
   * `toTargetingInput` + `buildTargeting` pair the publish path uses, so a
   * saved audience cannot encode targeting an ad set could not.
   */
  async function saveAudience() {
    const name = window.prompt(
      'Name this audience so you can reuse it on the next ad:',
    );
    if (!name?.trim()) return;

    setSavingAudience(true);
    try {
      const res = await fetch('/api/ads/audiences/saved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          targeting: {
            locations: state.locations.map((l) => ({
              key: l.key,
              type: l.type,
            })),
            excludedLocations: state.excludedLocations.map((l) => ({
              key: l.key,
              type: l.type,
            })),
            ageMin: state.ageMin,
            ageMax: state.ageMax,
            genders: state.genders,
            publisherPlatforms: state.publisherPlatforms,
            facebookPositions: state.facebookPositions,
            instagramPositions: state.instagramPositions,
            interests: state.interests.map((i) => ({
              id: i.id,
              category: i.category,
              name: i.name,
            })),
            customAudienceIds: state.customAudienceIds,
            excludedCustomAudienceIds: state.excludedCustomAudienceIds,
            audienceExpansion: state.audienceExpansion,
          },
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string | string[];
        } | null;
        const message = Array.isArray(body?.message)
          ? body.message.join(', ')
          : body?.message;
        throw new Error(message ?? 'Meta rejected the saved audience.');
      }

      toast.success('Audience saved. It will appear in the list above.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSavingAudience(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Saved audience */}
      {audiences?.saved.length ? (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Use a saved audience
          </span>
          <div className="flex items-center gap-2">
            <Select
              value={state.savedAudienceId || null}
              onValueChange={(next) => {
                if (typeof next === 'string') {
                  patch({ savedAudienceId: next });
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Build the audience below instead" />
              </SelectTrigger>
              <SelectContent>
                {audiences.saved.map((audience) => (
                  <SelectItem key={audience.id} value={audience.id}>
                    {audience.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {savedLocked ? (
              <button
                type="button"
                onClick={() => patch({ savedAudienceId: '' })}
                className="shrink-0 text-xs text-muted-foreground underline"
              >
                Clear
              </button>
            ) : null}
          </div>
          {savedLocked ? (
            <span className="mt-1.5 block text-xs text-amber-600 dark:text-amber-500">
              A saved audience already contains its own locations, ages and
              interests, so those fields are disabled below. Meta rejects the
              two together.
            </span>
          ) : null}
        </label>
      ) : null}

      {/* Custom / lookalike audiences */}
      {audiences?.custom.length ? (
        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground">
            Custom or lookalike audiences
          </p>
          <div className="flex flex-wrap gap-1.5">
            {audiences.custom.map((audience) => {
              const included = state.customAudienceIds.includes(audience.id);
              const excluded = state.excludedCustomAudienceIds.includes(
                audience.id,
              );
              return (
                <button
                  key={audience.id}
                  type="button"
                  onClick={() => {
                    // Three-state cycle: off → include → exclude → off.
                    // A separate "exclude" list with its own picker would
                    // double the controls for a rarely-used option.
                    if (!included && !excluded) {
                      patch({
                        customAudienceIds: [
                          ...state.customAudienceIds,
                          audience.id,
                        ],
                      });
                    } else if (included) {
                      patch({
                        customAudienceIds: state.customAudienceIds.filter(
                          (id) => id !== audience.id,
                        ),
                        excludedCustomAudienceIds: [
                          ...state.excludedCustomAudienceIds,
                          audience.id,
                        ],
                      });
                    } else {
                      patch({
                        excludedCustomAudienceIds:
                          state.excludedCustomAudienceIds.filter(
                            (id) => id !== audience.id,
                          ),
                      });
                    }
                  }}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    included
                      ? 'border-primary bg-primary-soft text-primary'
                      : excluded
                        ? 'border-destructive/40 bg-destructive/10 text-destructive line-through'
                        : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                  title={
                    excluded
                      ? 'Excluded — click to clear'
                      : included
                        ? 'Included — click to exclude'
                        : 'Click to include'
                  }
                >
                  {audience.name}
                  {audience.approximateCount ? (
                    <span className="ml-1 opacity-60">
                      {formatCompact(audience.approximateCount)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Click once to include, twice to exclude.
          </p>
        </div>
      ) : null}

      {/* Locations */}
      <LocationPicker
        label="Locations"
        selected={state.locations}
        disabled={savedLocked}
        onChange={(locations) => patch({ locations })}
      />
      <LocationPicker
        label="Exclude locations"
        selected={state.excludedLocations}
        disabled={savedLocked}
        onChange={(excludedLocations) => patch({ excludedLocations })}
      />

      {/* Gender + age */}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Gender
          </span>
          <Select
            value={
              state.genders.length === 0
                ? 'all'
                : state.genders[0] === 1
                  ? 'male'
                  : 'female'
            }
            disabled={savedLocked}
            onValueChange={(next) => {
              if (typeof next !== 'string') return;
              patch({
                genders:
                  next === 'all' ? [] : next === 'male' ? [1] : [2],
              });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="male">Men</SelectItem>
              <SelectItem value="female">Women</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Age range
          </span>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={18}
              max={65}
              value={state.ageMin}
              disabled={savedLocked}
              onChange={(e) =>
                patch({ ageMin: clampAge(Number(e.target.value)) })
              }
              className="w-20"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="number"
              min={18}
              max={65}
              value={state.ageMax}
              disabled={savedLocked}
              onChange={(e) =>
                patch({ ageMax: clampAge(Number(e.target.value)) })
              }
              className="w-20"
            />
          </div>
          {/* Not a silent clamp: the input refuses below 18 and says why. */}
          <span className="mt-1 block text-xs text-muted-foreground">
            18 is the minimum Meta allows for these objectives.
          </span>
        </div>
      </div>

      {/* Platforms & placements */}
      <div className="space-y-3">
        <p className="text-xs font-medium text-foreground">
          Platforms &amp; placements
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <PlacementGroup
            platform="facebook"
            label="Facebook"
            positions={FACEBOOK_POSITIONS}
            enabled={state.publisherPlatforms.includes('facebook')}
            selected={state.facebookPositions}
            onTogglePlatform={(on) =>
              patch({
                publisherPlatforms: on
                  ? [...state.publisherPlatforms, 'facebook']
                  : state.publisherPlatforms.filter((p) => p !== 'facebook'),
              })
            }
            onChange={(facebookPositions) => patch({ facebookPositions })}
          />
          <PlacementGroup
            platform="instagram"
            label="Instagram"
            positions={INSTAGRAM_POSITIONS}
            enabled={state.publisherPlatforms.includes('instagram')}
            selected={state.instagramPositions}
            onTogglePlatform={(on) =>
              patch({
                publisherPlatforms: on
                  ? [...state.publisherPlatforms, 'instagram']
                  : state.publisherPlatforms.filter((p) => p !== 'instagram'),
              })
            }
            onChange={(instagramPositions) => patch({ instagramPositions })}
          />
        </div>
      </div>

      {/* Advanced targeting */}
      <InterestPicker
        selected={state.interests}
        disabled={savedLocked}
        onChange={(interests) => patch({ interests })}
      />

      {/* Save this targeting for reuse. Offered only once there is
          something worth saving — an empty spec is not an audience. */}
      {!savedLocked && state.locations.length > 0 ? (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={savingAudience}
            onClick={() => void saveAudience()}
          >
            {savingAudience ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <BookmarkPlus className="size-3.5" />
            )}
            Save audience
          </Button>
        </div>
      ) : null}

      {/* Audience expansion */}
      <label className="flex items-start gap-3 rounded-lg border border-border p-3">
        <Switch
          checked={state.audienceExpansion}
          onCheckedChange={(next) => patch({ audienceExpansion: next })}
        />
        <span className="min-w-0">
          <span className="block text-sm text-foreground">
            Let Meta expand the audience
          </span>
          <span className="block text-xs text-muted-foreground">
            Meta may show the ad beyond the interests you picked when it
            expects better results. Off by default — it can reach people well
            outside your selection.
          </span>
        </span>
      </label>
    </div>
  );
}

function clampAge(value: number): number {
  if (!Number.isFinite(value)) return 18;
  return Math.min(65, Math.max(18, Math.round(value)));
}

// ============================================================
// Location autocomplete
// ============================================================

function LocationPicker({
  label,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  selected: GeoResult[];
  disabled?: boolean;
  onChange: (next: GeoResult[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Debounced: every keystroke is a Graph call against a rate limit the
  // whole workspace shares.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback((value: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (value.trim().length < 2) {
      setResults(null);
      return;
    }

    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/ads/search-locations?q=${encodeURIComponent(value)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error('Search failed');
        const json = (await res.json()) as { data: GeoResult[] };
        setResults(json.data);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-foreground">
        {label}
      </span>

      {selected.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selected.map((location) => (
            <span
              key={`${location.type}-${location.key}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-1 text-xs text-foreground"
            >
              <MapPin className="size-3 text-muted-foreground" />
              {location.name}
              {location.context ? (
                <span className="text-muted-foreground">
                  · {location.context}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  onChange(selected.filter((l) => l.key !== location.key))
                }
                aria-label={`Remove ${location.name}`}
                className="ml-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="relative">
        <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          disabled={disabled}
          placeholder="Search cities, regions, countries, pin codes"
          className="pl-8"
          onChange={(e) => {
            setQuery(e.target.value);
            search(e.target.value);
          }}
        />
        {searching ? (
          <Loader2 className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {results !== null && query.trim().length >= 2 ? (
        <ul className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-border bg-card">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              No matches.
            </li>
          ) : (
            results.map((result) => (
              <li key={`${result.type}-${result.key}`}>
                <button
                  type="button"
                  onClick={() => {
                    if (!selected.some((s) => s.key === result.key)) {
                      onChange([...selected, result]);
                    }
                    setQuery('');
                    setResults(null);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
                >
                  <span className="min-w-0 truncate text-foreground">
                    {result.name}
                    {result.context ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        {result.context}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                    {result.type}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

// ============================================================
// Placements
// ============================================================

function PlacementGroup({
  platform,
  label,
  positions,
  enabled,
  selected,
  onTogglePlatform,
  onChange,
}: {
  platform: string;
  label: string;
  positions: ReadonlyArray<{ value: string; label: string }>;
  enabled: boolean;
  selected: string[];
  onTogglePlatform: (on: boolean) => void;
  onChange: (next: string[]) => void;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-opacity',
        enabled ? 'border-border' : 'border-border/60 opacity-60',
      )}
    >
      <label className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Switch
            checked={enabled}
            onCheckedChange={onTogglePlatform}
            aria-label={`${label} placements`}
          />
          {label}
        </span>
        {enabled ? (
          <button
            type="button"
            onClick={() =>
              onChange(
                selected.length === positions.length
                  ? []
                  : positions.map((p) => p.value),
              )
            }
            className="text-xs text-muted-foreground underline"
          >
            {selected.length === positions.length ? 'Clear all' : 'Select all'}
          </button>
        ) : null}
      </label>

      {enabled ? (
        <>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {selected.length} of {positions.length} placements
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {positions.map((position) => {
              const on = selected.includes(position.value);
              return (
                <button
                  key={position.value}
                  type="button"
                  onClick={() =>
                    onChange(
                      on
                        ? selected.filter((p) => p !== position.value)
                        : [...selected, position.value],
                    )
                  }
                  aria-pressed={on}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs transition-colors',
                    on
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {position.label}
                </button>
              );
            })}
          </div>
          {selected.length === 0 ? (
            <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
              With no placement selected Meta chooses for you.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Not running on {label}. Turn on {platform} to pick placements.
        </p>
      )}
    </div>
  );
}

// ============================================================
// Interests
// ============================================================

function InterestPicker({
  selected,
  disabled,
  onChange,
}: {
  selected: TargetingCategory[];
  disabled?: boolean;
  onChange: (next: TargetingCategory[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TargetingCategory[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback((value: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (value.trim().length < 2) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/ads/search-interests?q=${encodeURIComponent(value)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error('Search failed');
        const json = (await res.json()) as { data: TargetingCategory[] };
        setResults(json.data);
      } catch {
        toast.error('Could not search interests.');
        setResults([]);
      }
    }, 350);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          Detailed targeting
        </span>
        {/* The legend is the only thing that makes the chip colours mean
            anything — colour alone would carry the category. */}
        <span className="flex items-center gap-2.5 text-[10px] text-muted-foreground">
          {(['interests', 'demographics', 'behaviors'] as const).map((key) => (
            <span key={key} className="flex items-center gap-1">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  key === 'interests'
                    ? 'bg-amber-500'
                    : key === 'demographics'
                      ? 'bg-violet-500'
                      : 'bg-emerald-500',
                )}
              />
              {key === 'behaviors' ? 'behaviours' : key}
            </span>
          ))}
        </span>
      </div>

      {selected.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selected.map((item) => (
            <span
              key={item.id}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs',
                CATEGORY_TONE[item.category] ?? 'border-border',
              )}
            >
              {item.name}
              <button
                type="button"
                onClick={() => onChange(selected.filter((s) => s.id !== item.id))}
                aria-label={`Remove ${item.name}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="relative">
        <Sparkles className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          disabled={disabled}
          placeholder="Type interests, demographics or behaviours"
          className="pl-8"
          onChange={(e) => {
            setQuery(e.target.value);
            search(e.target.value);
          }}
        />
      </div>

      {results !== null && query.trim().length >= 2 ? (
        <ul className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-border bg-card">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              No matches.
            </li>
          ) : (
            results.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!selected.some((s) => s.id === result.id)) {
                      onChange([...selected, result]);
                    }
                    setQuery('');
                    setResults(null);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">
                      {result.name}
                    </span>
                    {result.path.length ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {result.path.join(' › ')}
                      </span>
                    ) : null}
                  </span>
                  {result.audienceSize ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatCompact(result.audienceSize)}+
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {selected.length > 1 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          People matching <strong>any</strong> of these, not all of them.
        </p>
      ) : null}
    </div>
  );
}
