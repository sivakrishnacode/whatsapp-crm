'use client';

/**
 * The trigger's panel — same docked sidebar as a step's, minus the
 * footer, because there is exactly one trigger and it can be neither
 * duplicated nor deleted.
 *
 * The keyword-conflict warning is carried over from the old builder: two
 * automations (or an automation and a flow) listening for the same word
 * both fire, and the person who wrote the second one has no way to know
 * about the first.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, X, Zap } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { TRIGGER_COLORS } from '@/lib/automations/step-meta';
import type { Automation, AutomationTriggerType } from '@/types';
import { FieldBlock } from './token-field';
import { useAutomationResources, type FlowOption } from './resources';

export const TRIGGER_OPTIONS: {
  value: AutomationTriggerType;
  label: string;
  hint: string;
  channelLock?: string;
}[] = [
  {
    value: 'new_message_received',
    label: 'New message received',
    hint: 'Any incoming message',
  },
  {
    value: 'first_inbound_message',
    label: 'First message from a contact',
    hint: 'The first time this contact ever messages you (manually-added contacts too)',
  },
  {
    value: 'keyword_match',
    label: 'Keyword match',
    hint: 'The message contains one of your keywords',
  },
  {
    value: 'new_contact_created',
    label: 'New contact created',
    hint: 'A contact is created from an incoming message',
  },
  {
    value: 'conversation_assigned',
    label: 'Conversation assigned',
    hint: 'A thread is handed to an agent',
  },
  { value: 'tag_added', label: 'Tag added', hint: 'A tag lands on a contact' },
  { value: 'time_based', label: 'On a schedule', hint: 'Recurring, by cron or HH:mm' },
  {
    value: 'form_submitted',
    label: 'Form submitted',
    hint: 'Any form, or one you choose. Not tied to a channel.',
  },
  {
    value: 'appointment_booked',
    label: 'Appointment booked',
    hint: 'Someone books a slot',
  },
  {
    value: 'appointment_cancelled',
    label: 'Appointment cancelled',
    hint: 'Someone cancels a booking',
  },
  {
    value: 'web_chat_started',
    label: 'Web chat started',
    hint: 'A website visitor opens the widget and writes. Web only.',
    channelLock: 'web',
  },
  {
    value: 'instagram_comment',
    label: 'Instagram comment',
    hint: 'Someone comments on one of your posts. Instagram only.',
    channelLock: 'instagram',
  },
  {
    value: 'instagram_story_reply',
    label: 'Instagram story reply',
    hint: 'Someone replies to a story. Instagram only.',
    channelLock: 'instagram',
  },
];

const CHANNEL_OPTS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'web', label: 'Web' },
] as const;

const KEYWORD_TRIGGERS = new Set([
  'keyword_match',
  'instagram_comment',
  'instagram_story_reply',
]);

export function TriggerInspector({
  triggerType,
  config,
  channels,
  currentAutomationId,
  onTypeChange,
  onConfigChange,
  onChannelsChange,
  onClose,
}: {
  triggerType: AutomationTriggerType;
  config: Record<string, unknown>;
  channels: string[];
  currentAutomationId?: string;
  onTypeChange: (t: AutomationTriggerType) => void;
  onConfigChange: (c: Record<string, unknown>) => void;
  onChannelsChange: (c: string[]) => void;
  onClose: () => void;
}) {
  const { tags, forms, appointmentTypes } = useAutomationResources();
  const option = TRIGGER_OPTIONS.find((o) => o.value === triggerType);
  const channelLock = option?.channelLock;

  return (
    <aside
      aria-label="Trigger settings"
      style={{ '--nc-text': TRIGGER_COLORS.text } as React.CSSProperties}
      className="border-border bg-popover flex h-full min-h-0 w-full flex-col border-l"
    >
      <div className="border-border flex flex-none items-start gap-2.5 border-b px-4 pt-3.5 pb-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ background: TRIGGER_COLORS.soft, color: TRIGGER_COLORS.line }}
        >
          <Zap size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="text-[10.5px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--nc-text)' }}
          >
            Trigger
          </div>
          <h2 className="text-foreground truncate text-sm font-semibold">
            {option?.label ?? triggerType}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        >
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
        <FieldBlock label="When this happens" hint={option?.hint}>
          <select
            value={triggerType}
            onChange={(e) =>
              onTypeChange(e.target.value as AutomationTriggerType)
            }
            className="border-border bg-muted text-foreground focus:border-primary h-8 w-full rounded-lg border px-2 py-1 text-sm focus:outline-none"
          >
            {TRIGGER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldBlock>

        <FieldBlock
          label="Channels"
          hint={
            channelLock
              ? undefined
              : 'None selected means every channel — which is what an automation that never touched this means.'
          }
        >
          {channelLock ? (
            <div className="border-border bg-muted/50 flex items-center gap-1.5 rounded-lg border px-2 py-1.5">
              <span className="text-foreground text-xs capitalize">
                {channelLock}
              </span>
              <span className="text-muted-foreground ml-auto text-[10px]">
                locked by this trigger
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {CHANNEL_OPTS.map((ch) => {
                const active = channels.includes(ch.value);
                return (
                  <button
                    key={ch.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChannelsChange(
                        active
                          ? channels.filter((c) => c !== ch.value)
                          : [...channels, ch.value],
                      )
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                      active
                        ? 'border-primary/50 bg-primary/15 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {ch.label}
                  </button>
                );
              })}
            </div>
          )}
        </FieldBlock>

        {KEYWORD_TRIGGERS.has(triggerType) && (
          <>
            <KeywordConfig config={config} onChange={onConfigChange} />
            <KeywordConflicts
              currentAutomationId={currentAutomationId}
              keywords={(config.keywords as string[]) ?? []}
            />
          </>
        )}

        {triggerType === 'tag_added' && (
          <FieldBlock label="Tag">
            <select
              value={String(config.tag_id ?? '')}
              onChange={(e) =>
                onConfigChange({ ...config, tag_id: e.target.value })
              }
              className="border-border bg-muted text-foreground h-8 w-full rounded-lg border px-2 text-sm"
            >
              <option value="">Select a tag…</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </FieldBlock>
        )}

        {triggerType === 'time_based' && (
          <FieldBlock
            label="Schedule"
            hint="A cron expression, or HH:mm for a daily run."
          >
            <Input
              value={String(config.schedule ?? '')}
              onChange={(e) =>
                onConfigChange({ ...config, schedule: e.target.value })
              }
              placeholder="09:00"
              className="bg-muted font-mono text-[12px]"
            />
          </FieldBlock>
        )}

        {triggerType === 'form_submitted' && (
          <FieldBlock label="Form" hint="Leave blank to fire for any form.">
            <select
              value={String(config.form_id ?? '')}
              onChange={(e) =>
                onConfigChange({ ...config, form_id: e.target.value })
              }
              className="border-border bg-muted text-foreground h-8 w-full rounded-lg border px-2 text-sm"
            >
              <option value="">Any form</option>
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </FieldBlock>
        )}

        {(triggerType === 'appointment_booked' ||
          triggerType === 'appointment_cancelled' ||
          triggerType === 'appointment_rescheduled') && (
          <FieldBlock
            label="Appointment type"
            hint="Leave blank to fire for any type."
          >
            <select
              value={String(config.appointment_type_id ?? '')}
              onChange={(e) =>
                onConfigChange({
                  ...config,
                  appointment_type_id: e.target.value,
                })
              }
              className="border-border bg-muted text-foreground h-8 w-full rounded-lg border px-2 text-sm"
            >
              <option value="">Any type</option>
              {appointmentTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </FieldBlock>
        )}
      </div>
    </aside>
  );
}

function KeywordConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const keywords = (config.keywords as string[]) ?? [];
  // A local draft so the comma and trailing space are not stripped on
  // every keystroke — which made multi-word, comma-separated entry like
  // "SEO, search engine optimisation" impossible to type.
  const [draft, setDraft] = useState(keywords.join(', '));

  // Persist the default the select displays. Leaving match_type unset
  // meant activation validation rejected an automation that looked fine.
  useEffect(() => {
    if (config.match_type == null) {
      onChange({ ...config, match_type: 'contains' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = () => {
    const parsed = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setDraft(parsed.join(', '));
    onChange({ ...config, keywords: parsed });
  };

  return (
    <>
      <FieldBlock label="Keywords" hint="Comma-separated.">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          placeholder="pricing, demo, talk to sales"
          className="bg-muted"
        />
      </FieldBlock>
      <FieldBlock label="Match">
        <select
          value={String(config.match_type ?? 'contains')}
          onChange={(e) => onChange({ ...config, match_type: e.target.value })}
          className="border-border bg-muted text-foreground h-8 w-full rounded-lg border px-2 text-sm"
        >
          <option value="contains">Contains the keyword</option>
          <option value="exact">Is exactly the keyword</option>
        </select>
      </FieldBlock>
    </>
  );
}

interface KeywordConflict {
  keyword: string;
  sourceType: 'automation' | 'flow';
  name: string;
}

function KeywordConflicts({
  currentAutomationId,
  keywords,
}: {
  currentAutomationId?: string;
  keywords: string[];
}) {
  const { automations, flows } = useAutomationResources();
  const conflicts = useMemo(
    () => findKeywordConflicts(currentAutomationId, keywords, automations, flows),
    [currentAutomationId, keywords, automations, flows],
  );
  if (conflicts.length === 0) return null;

  return (
    <div className="border-warning/40 bg-warning-surface rounded-md border p-3">
      <div className="text-warning flex items-center gap-1.5 text-xs font-semibold">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Keyword conflict
      </div>
      <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
        These words already start something else. Both will fire on the same
        message.
      </p>
      <div className="mt-2 space-y-1">
        {conflicts.map((c, i) => (
          <div key={i} className="text-[11px]">
            <span className="text-foreground font-mono">“{c.keyword}”</span>
            <span className="text-muted-foreground">
              {' '}
              → {c.sourceType === 'automation' ? 'automation' : 'flow'}{' '}
            </span>
            <span className="text-foreground">{c.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function findKeywordConflicts(
  currentAutomationId: string | undefined,
  currentKeywords: string[],
  automations: Automation[],
  flows: FlowOption[],
): KeywordConflict[] {
  const normalized = (currentKeywords ?? [])
    .map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
    .filter(Boolean);
  if (normalized.length === 0) return [];

  const conflicts: KeywordConflict[] = [];
  const seen = new Set<string>();

  const add = (
    keyword: string,
    sourceType: 'automation' | 'flow',
    id: string,
    name: string,
  ) => {
    const dedupe = `${sourceType}:${id}:${keyword}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    conflicts.push({ keyword, sourceType, name });
  };

  for (const automation of automations) {
    if (currentAutomationId && automation.id === currentAutomationId) continue;
    if (
      automation.trigger_type !== 'keyword_match' &&
      automation.trigger_type !== 'instagram_comment' &&
      automation.trigger_type !== 'instagram_story_reply'
    ) {
      continue;
    }
    const theirs = ((automation.trigger_config as { keywords?: string[] })
      ?.keywords ?? []
    ).map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''));
    for (const kw of normalized) {
      if (theirs.includes(kw)) {
        add(kw, 'automation', automation.id, automation.name || 'Untitled');
      }
    }
  }

  for (const flow of flows) {
    if (flow.trigger_type !== 'keyword') continue;
    const theirs = ((flow.trigger_config as { keywords?: string[] })?.keywords ??
      []
    ).map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''));
    for (const kw of normalized) {
      if (theirs.includes(kw)) add(kw, 'flow', flow.id, flow.name || 'Untitled');
    }
  }

  return conflicts;
}
