'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Loader2, Save, Wrench, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ChipInput } from './chip-input';
import type { AgentStudio, SkillDefinition, SkillState } from '@/lib/agents/types';

type SkillMap = Record<string, SkillState>;

function initialState(studio: AgentStudio): SkillMap {
  const out: SkillMap = {};
  for (const skill of studio.skills_registry) {
    const saved = studio.skills?.[skill.id];
    out[skill.id] = {
      enabled: saved?.enabled ?? skill.default_enabled,
      config: saved?.config ?? {},
    };
  }
  return out;
}

/**
 * The jobs the agent is allowed to do.
 *
 * A skill is not a toggle over a feature flag — it is a paragraph in the
 * system prompt plus, for some, access to a tool that reads this
 * database. That is why "Order status" can answer truthfully and a
 * hand-written prompt cannot: the skill grants the lookup.
 *
 * The catalogue comes from the server (`skills_registry`), so a skill
 * added in `src/ai/lib/skills.ts` appears here without a web deploy.
 */
export function AgentSkills({
  studio,
  canEdit,
  saving,
  onSave,
}: {
  studio: AgentStudio;
  canEdit: boolean;
  saving: boolean;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [state, setState] = useState<SkillMap>(() => initialState(studio));
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [syncedFrom, setSyncedFrom] = useState(studio);

  // Adjust during render, not in an effect — see the note in
  // agent-persona.tsx. Unsaved toggles always win over a refetch.
  if (studio !== syncedFrom) {
    setSyncedFrom(studio);
    if (!dirty) setState(initialState(studio));
  }

  const enabledCount = useMemo(
    () => Object.values(state).filter((s) => s.enabled).length,
    [state],
  );

  const toggle = (id: string, enabled: boolean) => {
    setState((prev) => ({ ...prev, [id]: { ...prev[id], enabled } }));
    setDirty(true);
    if (enabled) setExpanded(id);
  };

  const setConfig = (id: string, key: string, value: unknown) => {
    setState((prev) => ({
      ...prev,
      [id]: { ...prev[id], config: { ...prev[id].config, [key]: value } },
    }));
    setDirty(true);
  };

  const save = async () => {
    const ok = await onSave({ skills: state });
    if (ok) setDirty(false);
  };

  const disabled = !canEdit || saving;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {enabledCount} of {studio.skills_registry.length} skills on. The agent
          picks whichever fits the customer’s message; if none fit, it says what
          it can help with instead of improvising.
        </p>
      </div>

      <ul className="space-y-3">
        {studio.skills_registry.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            state={state[skill.id] ?? { enabled: skill.default_enabled, config: {} }}
            expanded={expanded === skill.id}
            onExpand={() =>
              setExpanded((prev) => (prev === skill.id ? null : skill.id))
            }
            onToggle={(enabled) => toggle(skill.id, enabled)}
            onConfig={(key, value) => setConfig(skill.id, key, value)}
            disabled={disabled}
          />
        ))}
      </ul>

      <div className="flex items-center justify-end gap-3">
        {dirty && (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        )}
        <Button onClick={save} disabled={disabled || !dirty}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save skills
        </Button>
      </div>
    </div>
  );
}

function SkillCard({
  skill,
  state,
  expanded,
  onExpand,
  onToggle,
  onConfig,
  disabled,
}: {
  skill: SkillDefinition;
  state: SkillState;
  expanded: boolean;
  onExpand: () => void;
  onToggle: (enabled: boolean) => void;
  onConfig: (key: string, value: unknown) => void;
  disabled: boolean;
}) {
  const hasConfig = skill.config.length > 0;

  return (
    <li
      className={cn(
        'rounded-xl border bg-card transition-colors',
        state.enabled ? 'border-primary/30' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <div
          className={cn(
            'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
            state.enabled
              ? 'bg-primary/10 text-primary'
              : 'bg-muted text-muted-foreground',
          )}
        >
          <Zap className="size-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">{skill.label}</p>
            {skill.tools.length > 0 && (
              <Badge variant="outline" className="gap-1">
                <Wrench className="size-3" />
                {skill.tools.length === 1
                  ? '1 tool'
                  : `${skill.tools.length} tools`}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {skill.description}
          </p>

          {skill.tools.length > 0 && state.enabled && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Can call:{' '}
              <span className="font-mono text-[11px]">
                {skill.tools.join(', ')}
              </span>
            </p>
          )}

          {hasConfig && state.enabled && (
            <button
              type="button"
              onClick={onExpand}
              className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {expanded ? 'Hide settings' : 'Settings'}
              <ChevronDown
                className={cn('size-3 transition-transform', expanded && 'rotate-180')}
              />
            </button>
          )}
        </div>

        <Switch
          checked={state.enabled}
          onCheckedChange={onToggle}
          disabled={disabled}
          aria-label={`Enable ${skill.label}`}
        />
      </div>

      {hasConfig && state.enabled && expanded && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {skill.config.map((field) => {
            const value = state.config[field.key];
            const id = `${skill.id}-${field.key}`;

            return (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={id}>{field.label}</Label>

                {field.type === 'list' ? (
                  <ChipInput
                    values={Array.isArray(value) ? (value as string[]) : []}
                    onChange={(next) => onConfig(field.key, next)}
                    placeholder={field.placeholder ?? undefined}
                    disabled={disabled}
                    max={field.max_items ?? undefined}
                  />
                ) : field.type === 'textarea' ? (
                  <Textarea
                    id={id}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(e) => onConfig(field.key, e.target.value)}
                    placeholder={field.placeholder ?? undefined}
                    rows={3}
                    disabled={disabled}
                  />
                ) : (
                  <Input
                    id={id}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(e) => onConfig(field.key, e.target.value)}
                    placeholder={field.placeholder ?? undefined}
                    disabled={disabled}
                    inputMode={field.type === 'url' ? 'url' : 'text'}
                  />
                )}

                {field.help && (
                  <p className="text-xs text-muted-foreground">{field.help}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}
