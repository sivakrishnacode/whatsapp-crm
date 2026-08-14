'use client';

/**
 * The per-step forms rendered inside the inspector.
 *
 * One dispatcher (`StepFields`) plus one component per step type. Every
 * text field that could usefully carry data from an earlier step is a
 * `TokenInput`, which is most of them — that is the point of the
 * rewrite. Pickers that resolve ids to names (tags, segments, agents,
 * templates, pipelines) are ported from the old stacked-card builder,
 * where they already handled the awkward cases: an empty list falls back
 * to a raw id input, and a saved-but-since-deleted id is preserved as a
 * labelled option rather than silently dropped.
 */

import { useState } from 'react';

import { Input } from '@/components/ui/input';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { tint } from '@/lib/tint';
import { collectTemplateSlots } from '@/lib/whatsapp/template-slots';
import type { TokenGroup } from '@/lib/automations/tokens';
import type { AutomationStepType, MessageTemplate } from '@/types';
import {
  FieldBlock,
  KeyValueTable,
  TokenInput,
} from './token-field';
import { useAutomationResources } from './resources';
import { AppActionFields } from './app-action-fields';

const SELECT_CLASS =
  'border-border bg-muted text-foreground focus:border-primary h-8 w-full rounded-lg border px-2 py-1 text-sm focus:outline-none';

export interface StepFieldsProps {
  type: AutomationStepType;
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  /** Available data for THIS step — what ran before it. */
  groups: TokenGroup[];
}

export function StepFields(props: StepFieldsProps) {
  switch (props.type) {
    case 'send_message':
      return (
        <TokenInput
          label="Message"
          multiline
          rows={5}
          value={str(props.config.text)}
          onChange={(v) => props.onChange({ text: v })}
          groups={props.groups}
          placeholder="Hi {{ contact.name }} — thanks for getting in touch!"
        />
      );
    case 'send_template':
      return <SendTemplateFields {...props} />;
    case 'send_media':
      return <SendMediaFields {...props} />;
    case 'send_buttons':
      return <SendButtonsFields {...props} />;
    case 'send_list':
      return <SendListFields {...props} />;
    case 'send_form':
    case 'send_booking_link':
      return <SendLinkFields {...props} />;
    case 'add_tag':
    case 'remove_tag':
      return <TagFields {...props} />;
    case 'add_to_segment':
    case 'remove_from_segment':
      return <SegmentFields {...props} />;
    case 'update_contact_field':
      return <ContactFieldFields {...props} />;
    case 'add_note':
      return (
        <TokenInput
          label="Note"
          multiline
          value={str(props.config.text)}
          onChange={(v) => props.onChange({ text: v })}
          groups={props.groups}
          hint="Internal only — the contact never sees this."
        />
      );
    case 'assign_conversation':
      return <AssignFields {...props} />;
    case 'set_conversation_status':
      return (
        <FieldBlock label="Set the conversation to">
          <select
            value={str(props.config.status) || 'closed'}
            onChange={(e) => props.onChange({ status: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="closed">Closed</option>
          </select>
        </FieldBlock>
      );
    case 'close_conversation':
      return (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Marks the conversation closed. Nothing to configure — the newer
          <strong className="text-foreground"> Set status </strong> step does
          this and more.
        </p>
      );
    case 'create_deal':
      return <CreateDealFields {...props} />;
    case 'update_deal':
      return <UpdateDealFields {...props} />;
    case 'notify_team':
      return <NotifyTeamFields {...props} />;
    case 'wait':
      return <WaitFields {...props} />;
    case 'wait_until':
      return <WaitUntilFields {...props} />;
    case 'condition':
      return <ConditionFields {...props} />;
    case 'random_split':
      return <RandomSplitFields {...props} />;
    case 'app_action':
      // Rendered entirely from the action's FieldSpec list — see
      // app-action-fields.tsx. No per-app form exists or should.
      return <AppActionFields {...props} />;
    case 'http_request':
    case 'send_webhook':
      return <HttpRequestFields {...props} />;
    case 'set_variable':
      return <SetVariableFields {...props} />;
    case 'start_flow':
      return <StartFlowFields {...props} />;
    case 'run_automation':
      return <RunAutomationFields {...props} />;
    default:
      return (
        <p className="text-muted-foreground text-xs">
          This step has no settings.
        </p>
      );
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ============================================================
// Messaging
// ============================================================

function SendMediaFields({ config, onChange, groups }: StepFieldsProps) {
  return (
    <>
      <FieldBlock label="Type">
        <select
          value={str(config.kind) || 'image'}
          onChange={(e) => onChange({ kind: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="image">Image</option>
          <option value="video">Video</option>
          <option value="document">Document</option>
          <option value="audio">Audio</option>
        </select>
      </FieldBlock>
      <TokenInput
        label="Media URL"
        value={str(config.link)}
        onChange={(v) => onChange({ link: v })}
        groups={groups}
        placeholder="https://… or {{ steps.lookup.body.invoice_url }}"
        hint="Must be publicly reachable — WhatsApp fetches it directly."
      />
      {config.kind !== 'audio' && (
        <TokenInput
          label="Caption"
          value={str(config.caption)}
          onChange={(v) => onChange({ caption: v })}
          groups={groups}
        />
      )}
      {config.kind === 'document' && (
        <TokenInput
          label="File name"
          value={str(config.filename)}
          onChange={(v) => onChange({ filename: v })}
          groups={groups}
          hint="What the recipient sees the file called."
        />
      )}
    </>
  );
}

function SendButtonsFields({ config, onChange, groups }: StepFieldsProps) {
  const buttons = Array.isArray(config.buttons)
    ? (config.buttons as { id?: string; title?: string }[])
    : [];
  const set = (next: typeof buttons) => onChange({ buttons: next });

  return (
    <>
      <TokenInput
        label="Message"
        multiline
        value={str(config.body_text)}
        onChange={(v) => onChange({ body_text: v })}
        groups={groups}
      />
      <FieldBlock
        label="Buttons"
        hint="WhatsApp allows 3. The id is what comes back when they tap — a keyword automation or a flow can match on it."
      >
        <div className="space-y-1.5">
          {buttons.map((b, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_28px] gap-1.5">
              <Input
                value={b.title ?? ''}
                onChange={(e) => {
                  const next = [...buttons];
                  next[i] = { ...b, title: e.target.value };
                  set(next);
                }}
                placeholder="Button label"
                className="bg-muted h-8 text-[12px]"
              />
              <Input
                value={b.id ?? ''}
                onChange={(e) => {
                  const next = [...buttons];
                  next[i] = { ...b, id: e.target.value };
                  set(next);
                }}
                placeholder={`btn_${i + 1}`}
                className="bg-muted h-8 font-mono text-[12px]"
              />
              <button
                type="button"
                onClick={() => set(buttons.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-destructive text-xs"
                aria-label="Remove button"
              >
                ✕
              </button>
            </div>
          ))}
          {buttons.length < 3 && (
            <button
              type="button"
              onClick={() =>
                set([...buttons, { id: `btn_${buttons.length + 1}`, title: '' }])
              }
              className="text-muted-foreground hover:text-foreground border-border hover:border-primary/40 w-full rounded-md border border-dashed py-1.5 text-[11.5px]"
            >
              + Add button
            </button>
          )}
        </div>
      </FieldBlock>
      <TokenInput
        label="Footer (optional)"
        value={str(config.footer_text)}
        onChange={(v) => onChange({ footer_text: v })}
        groups={groups}
      />
    </>
  );
}

function SendListFields({ config, onChange, groups }: StepFieldsProps) {
  const sections = Array.isArray(config.sections)
    ? (config.sections as {
        title?: string;
        rows?: { id?: string; title?: string; description?: string }[];
      }[])
    : [];
  const set = (next: typeof sections) => onChange({ sections: next });
  const rowCount = sections.reduce((n, s) => n + (s.rows?.length ?? 0), 0);

  return (
    <>
      <TokenInput
        label="Message"
        multiline
        value={str(config.body_text)}
        onChange={(v) => onChange({ body_text: v })}
        groups={groups}
      />
      <FieldBlock label="Button label" hint="What opens the list — e.g. “View options”.">
        <Input
          value={str(config.button_label)}
          onChange={(e) => onChange({ button_label: e.target.value })}
          placeholder="Choose"
          className="bg-muted"
        />
      </FieldBlock>

      <FieldBlock
        label="Sections"
        hint={`${rowCount}/10 rows. Instagram has no list message — this step is skipped there.`}
      >
        <div className="space-y-3">
          {sections.map((section, si) => (
            <div key={si} className="border-border space-y-1.5 rounded-lg border p-2">
              <div className="flex gap-1.5">
                <Input
                  value={section.title ?? ''}
                  onChange={(e) => {
                    const next = [...sections];
                    next[si] = { ...section, title: e.target.value };
                    set(next);
                  }}
                  placeholder="Section title"
                  className="bg-muted h-8 text-[12px]"
                />
                <button
                  type="button"
                  onClick={() => set(sections.filter((_, j) => j !== si))}
                  className="text-muted-foreground hover:text-destructive px-1 text-xs"
                  aria-label="Remove section"
                >
                  ✕
                </button>
              </div>
              {(section.rows ?? []).map((row, ri) => (
                <div key={ri} className="grid grid-cols-[1fr_1fr_24px] gap-1.5">
                  <Input
                    value={row.title ?? ''}
                    onChange={(e) => {
                      const next = [...sections];
                      const rows = [...(section.rows ?? [])];
                      rows[ri] = { ...row, title: e.target.value };
                      next[si] = { ...section, rows };
                      set(next);
                    }}
                    placeholder="Option"
                    className="bg-muted h-8 text-[12px]"
                  />
                  <Input
                    value={row.id ?? ''}
                    onChange={(e) => {
                      const next = [...sections];
                      const rows = [...(section.rows ?? [])];
                      rows[ri] = { ...row, id: e.target.value };
                      next[si] = { ...section, rows };
                      set(next);
                    }}
                    placeholder={`row_${ri + 1}`}
                    className="bg-muted h-8 font-mono text-[12px]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...sections];
                      next[si] = {
                        ...section,
                        rows: (section.rows ?? []).filter((_, j) => j !== ri),
                      };
                      set(next);
                    }}
                    className="text-muted-foreground hover:text-destructive text-xs"
                    aria-label="Remove option"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  const next = [...sections];
                  const rows = [...(section.rows ?? [])];
                  rows.push({ id: `row_${si + 1}_${rows.length + 1}`, title: '' });
                  next[si] = { ...section, rows };
                  set(next);
                }}
                className="text-muted-foreground hover:text-foreground text-[11.5px]"
              >
                + Add option
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              set([...sections, { title: `Section ${sections.length + 1}`, rows: [] }])
            }
            className="text-muted-foreground hover:text-foreground border-border w-full rounded-md border border-dashed py-1.5 text-[11.5px]"
          >
            + Add section
          </button>
        </div>
      </FieldBlock>
    </>
  );
}

function SendLinkFields({ type, config, onChange, groups }: StepFieldsProps) {
  const { forms, appointmentTypes } = useAutomationResources();
  const isForm = type === 'send_form';
  const options = isForm ? forms : appointmentTypes;
  const field = isForm ? 'form_id' : 'appointment_type_id';
  const current = str(config[field]);

  return (
    <>
      <FieldBlock label={isForm ? 'Form' : 'Appointment type'}>
        {options.length === 0 ? (
          <Input
            value={current}
            onChange={(e) => onChange({ [field]: e.target.value })}
            placeholder={isForm ? 'Form id' : 'Appointment type id'}
            className="bg-muted font-mono text-[12px]"
          />
        ) : (
          <select
            value={current}
            onChange={(e) => onChange({ [field]: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">Select…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            {current && !options.some((o) => o.id === current) && (
              <option value={current}>{current} (no longer available)</option>
            )}
          </select>
        )}
      </FieldBlock>
      <TokenInput
        label="Message sent with the link"
        multiline
        rows={3}
        value={str(config.message_text)}
        onChange={(v) => onChange({ message_text: v })}
        groups={groups}
        hint="Leave blank for the default wording."
      />
    </>
  );
}

function SendTemplateFields({ config, onChange, groups }: StepFieldsProps) {
  const { templates } = useAutomationResources();
  const templateName = str(config.template_name);
  const language = str(config.language);
  const variables = (config.variables as Record<string, string>) ?? {};

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock
          label="Template name"
          hint="No approved templates synced yet — enter the name exactly as it appears in WhatsApp Manager."
        >
          <Input
            value={templateName}
            onChange={(e) => onChange({ template_name: e.target.value })}
            className="bg-muted"
          />
        </FieldBlock>
        <FieldBlock label="Language">
          <Input
            value={language}
            onChange={(e) => onChange({ language: e.target.value })}
            placeholder="en_US"
            className="bg-muted"
          />
        </FieldBlock>
      </>
    );
  }

  const toValue = (name: string, lang: string) => `${name}::${lang}`;
  const current = templateName ? toValue(templateName, language) : '';
  const selected = templates.find(
    (t) => toValue(t.name, t.language ?? 'en_US') === current,
  );
  const slots = selected ? collectTemplateSlots(selected as MessageTemplate) : null;
  const variableKeys = slots?.bodyVars ?? [];

  return (
    <>
      <FieldBlock label="Template">
        <select
          value={current}
          onChange={(e) => {
            const [name, lang] = e.target.value.split('::');
            // Drop the old values: they were positioned against a
            // different template's placeholders, and carrying them over
            // would send the last template's copy in this one's slots.
            onChange({
              template_name: name ?? '',
              language: lang ?? '',
              variables: {},
              button_params: {},
              header_text: '',
              header_media_url: '',
              header_location: undefined,
            });
          }}
          className={SELECT_CLASS}
        >
          <option value="">Select a template…</option>
          {templates.map((t) => {
            const lang = t.language ?? 'en_US';
            return (
              <option key={t.id} value={toValue(t.name, lang)}>
                {t.name} ({lang})
              </option>
            );
          })}
          {current && !selected && (
            <option value={current}>
              {templateName} ({language || 'unknown'}) — not approved
            </option>
          )}
        </select>
      </FieldBlock>

      {slots?.headerTextVars.length ? (
        <TokenInput
          label="Header variable"
          value={str(config.header_text)}
          onChange={(v) => onChange({ header_text: v })}
          groups={groups}
        />
      ) : null}

      {slots?.headerMedia && (
        <TokenInput
          label={`${slots.headerMedia.kind} header URL`}
          value={str(config.header_media_url)}
          onChange={(v) => onChange({ header_media_url: v })}
          groups={groups}
          hint={
            slots.headerMedia.hasDefault
              ? 'Leave blank to use the template’s own media.'
              : 'This template has no saved media, so a URL is required on every send.'
          }
        />
      )}

      {variableKeys.length > 0 && (
        <div className="space-y-3">
          {variableKeys.map((key) => (
            <TokenInput
              key={key}
              label={`Variable {{${key}}}`}
              value={variables[key] ?? ''}
              onChange={(v) =>
                onChange({ variables: { ...variables, [key]: v } })
              }
              groups={groups}
              invalid={!(variables[key] ?? '').trim()}
              hint={
                !(variables[key] ?? '').trim()
                  ? 'Every variable needs a value — WhatsApp rejects a send whose parameter count doesn’t match.'
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

// ============================================================
// Contact
// ============================================================

function TagFields({ config, onChange }: StepFieldsProps) {
  const { tags } = useAutomationResources();
  const value = str(config.tag_id);
  const selected = tags.find((t) => t.id === value);
  return (
    <FieldBlock label="Tag">
      {tags.length === 0 ? (
        <Input
          value={value}
          onChange={(e) => onChange({ tag_id: e.target.value })}
          placeholder="Tag id"
          className="bg-muted font-mono text-[12px]"
        />
      ) : (
        <div className="flex items-center gap-2">
          <span
            className="tint-mark border-border h-3 w-3 shrink-0 rounded-full border"
            style={tint(selected?.color)}
            aria-hidden
          />
          <select
            value={value}
            onChange={(e) => onChange({ tag_id: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">Select a tag…</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            {/* A tag that has since been deleted is preserved rather than
                silently dropped when this automation is re-saved. */}
            {value && !selected && (
              <option value={value}>{value} (unknown tag)</option>
            )}
          </select>
        </div>
      )}
    </FieldBlock>
  );
}

function SegmentFields({ config, onChange }: StepFieldsProps) {
  const { segments } = useAutomationResources();
  const value = str(config.segment_id);
  const selected = segments.find((s) => s.id === value);
  return (
    <FieldBlock
      label="Segment"
      hint={
        selected?.kind === 'dynamic'
          ? 'This is a filter segment. Its members are worked out from its rules, so this step will fail at run time.'
          : 'Only static segments can be edited — a filter segment computes its own members.'
      }
    >
      {segments.length === 0 ? (
        <Input
          value={value}
          onChange={(e) => onChange({ segment_id: e.target.value })}
          placeholder="Segment id"
          className="bg-muted font-mono text-[12px]"
        />
      ) : (
        <select
          value={value}
          onChange={(e) => onChange({ segment_id: e.target.value })}
          className={cn(
            SELECT_CLASS,
            selected?.kind === 'dynamic' && 'border-destructive',
          )}
        >
          <option value="">Select a segment…</option>
          {segments.map((s) => (
            // Listed but disabled, not filtered out: a segment missing
            // from a dropdown reads as a bug, whereas a greyed-out one
            // with a reason is a rule you learn once.
            <option key={s.id} value={s.id} disabled={s.kind === 'dynamic'}>
              {s.name}
              {s.kind === 'dynamic' ? ' (filter — members are automatic)' : ''}
            </option>
          ))}
          {value && !selected && (
            <option value={value}>{value} (unknown segment)</option>
          )}
        </select>
      )}
    </FieldBlock>
  );
}

function ContactFieldFields({ config, onChange, groups }: StepFieldsProps) {
  const { customFields } = useAutomationResources();
  const value = str(config.field) || 'name';
  const isCustom = value.startsWith('custom:');
  const knownCustom =
    isCustom && customFields.some((f) => `custom:${f.id}` === value);
  return (
    <>
      <FieldBlock label="Field">
        <select
          value={value}
          onChange={(e) => onChange({ field: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="name">Name</option>
          <option value="email">Email</option>
          <option value="company">Company</option>
          {customFields.length > 0 && (
            <optgroup label="Custom fields">
              {customFields.map((f) => (
                <option key={f.id} value={`custom:${f.id}`}>
                  {f.field_name}
                </option>
              ))}
            </optgroup>
          )}
          {isCustom && !knownCustom && (
            <option value={value}>{value} (unknown field)</option>
          )}
        </select>
      </FieldBlock>
      <TokenInput
        label="New value"
        value={str(config.value)}
        onChange={(v) => onChange({ value: v })}
        groups={groups}
        placeholder="{{ steps.lookup.body.customer.tier }}"
      />
    </>
  );
}

// ============================================================
// Conversation / CRM
// ============================================================

function AssignFields({ config, onChange }: StepFieldsProps) {
  const { members } = useAutomationResources();
  const agentId = str(config.agent_id);
  const selected = members.find((m) => m.user_id === agentId);
  return (
    <>
      <FieldBlock label="Assign to">
        <select
          value={str(config.mode) || 'round_robin'}
          onChange={(e) => onChange({ mode: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="round_robin">Round-robin</option>
          <option value="specific">A specific agent</option>
        </select>
      </FieldBlock>
      {config.mode === 'specific' && (
        <FieldBlock label="Agent">
          {members.length === 0 ? (
            <Input
              value={agentId}
              onChange={(e) => onChange({ agent_id: e.target.value })}
              placeholder="Agent id"
              className="bg-muted font-mono text-[12px]"
            />
          ) : (
            <select
              value={agentId}
              onChange={(e) => onChange({ agent_id: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="">Select an agent…</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name || m.email || m.user_id}
                </option>
              ))}
              {agentId && !selected && (
                <option value={agentId}>{agentId} (unknown agent)</option>
              )}
            </select>
          )}
        </FieldBlock>
      )}
    </>
  );
}

function PipelineStagePicker({
  pipelineId,
  stageId,
  onChange,
  requirePipeline = true,
}: {
  pipelineId: string;
  stageId: string;
  onChange: (patch: Record<string, unknown>) => void;
  requirePipeline?: boolean;
}) {
  const { pipelines, stages } = useAutomationResources();
  const stageOptions = stages.filter(
    (s) => !pipelineId || s.pipeline_id === pipelineId,
  );
  const selectedStage = stageOptions.find((s) => s.id === stageId);

  return (
    <>
      {requirePipeline && (
        <FieldBlock label="Pipeline">
          <select
            value={pipelineId}
            onChange={(e) => {
              const nextPipelineId = e.target.value;
              const firstStage = stages.find(
                (s) => s.pipeline_id === nextPipelineId,
              );
              // Stages belong to a pipeline, so keeping the old stage id
              // would point the deal at another board's column.
              onChange({
                pipeline_id: nextPipelineId,
                stage_id: firstStage?.id ?? '',
              });
            }}
            className={SELECT_CLASS}
          >
            <option value="">Select a pipeline…</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </FieldBlock>
      )}
      <FieldBlock label="Stage">
        <select
          value={stageId}
          onChange={(e) => onChange({ stage_id: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">
            {requirePipeline && !pipelineId
              ? 'Select a pipeline first…'
              : 'Select a stage…'}
          </option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {stageId && !selectedStage && (
            <option value={stageId}>{stageId} (unknown stage)</option>
          )}
        </select>
      </FieldBlock>
    </>
  );
}

function CreateDealFields({ config, onChange, groups }: StepFieldsProps) {
  return (
    <>
      <PipelineStagePicker
        pipelineId={str(config.pipeline_id)}
        stageId={str(config.stage_id)}
        onChange={onChange}
      />
      <TokenInput
        label="Deal title"
        value={str(config.title)}
        onChange={(v) => onChange({ title: v })}
        groups={groups}
        placeholder="Enquiry from {{ contact.name }}"
      />
      <TokenInput
        label="Value"
        value={str(config.value)}
        onChange={(v) => onChange({ value: v })}
        groups={groups}
        hint="A number, or a token like {{ steps.lookup.body.order.total }}."
      />
    </>
  );
}

function UpdateDealFields({ config, onChange, groups }: StepFieldsProps) {
  const target = str(config.target) || 'latest_for_contact';
  return (
    <>
      <FieldBlock label="Which deal">
        <select
          value={target}
          onChange={(e) => onChange({ target: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="latest_for_contact">
            This contact’s most recent deal
          </option>
          <option value="by_id">A specific deal id</option>
        </select>
      </FieldBlock>
      {target === 'by_id' && (
        <TokenInput
          label="Deal id"
          value={str(config.deal_id)}
          onChange={(v) => onChange({ deal_id: v })}
          groups={groups}
          placeholder="{{ steps.create_deal.deal_id }}"
        />
      )}
      <PipelineStagePicker
        pipelineId=""
        stageId={str(config.stage_id)}
        onChange={onChange}
        requirePipeline={false}
      />
      <FieldBlock label="Mark as">
        <select
          value={str(config.status)}
          onChange={(e) => onChange({ status: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">Leave unchanged</option>
          <option value="open">Open</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </select>
      </FieldBlock>
      <TokenInput
        label="Value"
        value={str(config.value)}
        onChange={(v) => onChange({ value: v })}
        groups={groups}
        hint="Leave blank to leave it alone."
      />
    </>
  );
}

function NotifyTeamFields({ config, onChange, groups }: StepFieldsProps) {
  const { members } = useAutomationResources();
  const recipient = str(config.recipient) || 'all';
  return (
    <>
      <FieldBlock label="Notify">
        <select
          value={recipient}
          onChange={(e) => onChange({ recipient: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="all">Everyone in the workspace</option>
          <option value="assigned_agent">
            Whoever the conversation is assigned to
          </option>
          <option value="specific">One specific person</option>
        </select>
      </FieldBlock>
      {recipient === 'specific' && (
        <FieldBlock label="Person">
          <select
            value={str(config.user_id)}
            onChange={(e) => onChange({ user_id: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">Select…</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.full_name || m.email || m.user_id}
              </option>
            ))}
          </select>
        </FieldBlock>
      )}
      <TokenInput
        label="Title"
        value={str(config.title)}
        onChange={(v) => onChange({ title: v })}
        groups={groups}
        placeholder="Hot lead: {{ contact.name }}"
      />
      <TokenInput
        label="Details"
        multiline
        rows={3}
        value={str(config.body)}
        onChange={(v) => onChange({ body: v })}
        groups={groups}
      />
    </>
  );
}

// ============================================================
// Logic & timing
// ============================================================

function WaitFields({ config, onChange }: StepFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <FieldBlock label="Wait for">
        <Input
          type="number"
          min={1}
          value={Number(config.amount ?? 1)}
          onChange={(e) =>
            onChange({ amount: Math.max(1, Number(e.target.value)) })
          }
          className="bg-muted"
        />
      </FieldBlock>
      <FieldBlock label="Unit">
        <select
          value={str(config.unit) || 'hours'}
          onChange={(e) => onChange({ unit: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="minutes">Minutes</option>
          <option value="hours">Hours</option>
          <option value="days">Days</option>
        </select>
      </FieldBlock>
    </div>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function WaitUntilFields({ config, onChange }: StepFieldsProps) {
  const days = Array.isArray(config.days) ? (config.days as number[]) : [];
  return (
    <>
      <FieldBlock
        label="Wait until"
        hint="24-hour clock. “In 12 hours” and “at 9am” are different rules — this is the second one."
      >
        <Input
          type="time"
          value={str(config.time) || '09:00'}
          onChange={(e) => onChange({ time: e.target.value })}
          className="bg-muted"
        />
      </FieldBlock>
      <FieldBlock
        label="Timezone"
        hint="An IANA zone such as Asia/Kolkata. Defaults to UTC — never the server’s local time, which would differ per deploy."
      >
        <Input
          value={str(config.timezone) || 'UTC'}
          onChange={(e) => onChange({ timezone: e.target.value })}
          placeholder="UTC"
          className="bg-muted font-mono text-[12px]"
        />
      </FieldBlock>
      <FieldBlock label="Only on these days" hint="None selected = any day.">
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((label, index) => {
            const active = days.includes(index);
            return (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onChange({
                    days: active
                      ? days.filter((d) => d !== index)
                      : [...days, index].sort(),
                  })
                }
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                  active
                    ? 'border-primary/50 bg-primary/15 text-primary'
                    : 'border-border bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </FieldBlock>
    </>
  );
}

function RandomSplitFields({ config, onChange }: StepFieldsProps) {
  const percent = Number(config.percent ?? 50);
  return (
    <FieldBlock
      label={`${percent}% take the first path`}
      hint="Rolled per run, not per contact — the same person can land in different halves on different runs."
    >
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        onChange={(e) => onChange({ percent: Number(e.target.value) })}
        className="accent-primary w-full"
      />
      <div className="text-muted-foreground flex justify-between text-[11px]">
        <span>{percent}% yes</span>
        <span>{100 - percent}% no</span>
      </div>
    </FieldBlock>
  );
}

const CONDITION_SUBJECTS: { value: string; label: string; operandLabel: string | null }[] = [
  { value: 'tag_presence', label: 'Has tag', operandLabel: 'Tag' },
  { value: 'contact_field', label: 'Contact field', operandLabel: 'Field' },
  { value: 'message_content', label: 'Message text', operandLabel: null },
  { value: 'expression', label: 'Data from an earlier step', operandLabel: 'Token path' },
  { value: 'segment_membership', label: 'In segment', operandLabel: 'Segment' },
  { value: 'channel', label: 'Channel', operandLabel: null },
  { value: 'time_of_day', label: 'Time of day', operandLabel: 'Window (HH:mm-HH:mm)' },
  { value: 'day_of_week', label: 'Day of week', operandLabel: 'Days (mon,tue…)' },
];

const OPERATORS: { value: string; label: string; needsValue: boolean }[] = [
  { value: 'equals', label: 'is', needsValue: true },
  { value: 'not_equals', label: 'is not', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'not_contains', label: 'does not contain', needsValue: true },
  { value: 'starts_with', label: 'starts with', needsValue: true },
  { value: 'ends_with', label: 'ends with', needsValue: true },
  { value: 'greater_than', label: 'is greater than', needsValue: true },
  { value: 'less_than', label: 'is less than', needsValue: true },
  { value: 'matches_regex', label: 'matches regex', needsValue: true },
  { value: 'is_empty', label: 'is empty', needsValue: false },
  { value: 'is_not_empty', label: 'is not empty', needsValue: false },
];

interface Rule {
  subject?: string;
  operand?: string;
  operator?: string;
  value?: string;
}

function ConditionFields({ config, onChange, groups }: StepFieldsProps) {
  const { tags, segments } = useAutomationResources();
  // Lift the legacy single-rule shape so an automation written before
  // rules[] existed opens in the new editor instead of looking empty.
  const rules: Rule[] = Array.isArray(config.rules)
    ? (config.rules as Rule[])
    : config.subject
      ? [
          {
            subject: str(config.subject),
            operand: str(config.operand),
            value: str(config.value),
          },
        ]
      : [];

  const set = (next: Rule[]) =>
    // Clear the legacy fields on write so the two shapes cannot disagree.
    onChange({ rules: next, subject: undefined, operand: undefined, value: undefined });

  return (
    <>
      {rules.length > 1 && (
        <FieldBlock label="Match">
          <select
            value={str(config.match) || 'all'}
            onChange={(e) => onChange({ match: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="all">All of these rules</option>
            <option value="any">Any of these rules</option>
          </select>
        </FieldBlock>
      )}

      <div className="space-y-3">
        {rules.map((rule, i) => {
          const subject = CONDITION_SUBJECTS.find((s) => s.value === rule.subject);
          const operator = OPERATORS.find((o) => o.value === (rule.operator ?? 'equals'));
          const patch = (p: Partial<Rule>) => {
            const next = [...rules];
            next[i] = { ...rule, ...p };
            set(next);
          };
          return (
            <div key={i} className="border-border space-y-2 rounded-lg border p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px] tracking-wider uppercase">
                  {i === 0 ? 'If' : str(config.match) === 'any' ? 'Or' : 'And'}
                </span>
                <button
                  type="button"
                  onClick={() => set(rules.filter((_, j) => j !== i))}
                  className="text-muted-foreground hover:text-destructive ml-auto text-xs"
                  aria-label="Remove rule"
                >
                  ✕
                </button>
              </div>

              <select
                value={rule.subject ?? ''}
                onChange={(e) => patch({ subject: e.target.value, operand: '' })}
                className={SELECT_CLASS}
              >
                <option value="">Choose what to check…</option>
                {CONDITION_SUBJECTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>

              {rule.subject === 'tag_presence' && (
                <select
                  value={rule.operand ?? ''}
                  onChange={(e) => patch({ operand: e.target.value })}
                  className={SELECT_CLASS}
                >
                  <option value="">Select a tag…</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}

              {rule.subject === 'segment_membership' && (
                <select
                  value={rule.operand ?? ''}
                  onChange={(e) => patch({ operand: e.target.value })}
                  className={SELECT_CLASS}
                >
                  <option value="">Select a segment…</option>
                  {segments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}

              {subject?.operandLabel &&
                rule.subject !== 'tag_presence' &&
                rule.subject !== 'segment_membership' && (
                  <Input
                    value={rule.operand ?? ''}
                    onChange={(e) => patch({ operand: e.target.value })}
                    placeholder={
                      rule.subject === 'expression'
                        ? 'steps.lookup.status'
                        : subject.operandLabel
                    }
                    className="bg-muted font-mono text-[12px]"
                  />
                )}

              {/* Presence and membership are already yes/no questions —
                  an operator row there would be a second way to say the
                  same thing, and a confusing one. */}
              {rule.subject &&
                rule.subject !== 'tag_presence' &&
                rule.subject !== 'segment_membership' &&
                rule.subject !== 'time_of_day' &&
                rule.subject !== 'day_of_week' && (
                  <div className="grid grid-cols-[auto_1fr] gap-2">
                    <select
                      value={rule.operator ?? 'equals'}
                      onChange={(e) => patch({ operator: e.target.value })}
                      className={SELECT_CLASS}
                    >
                      {OPERATORS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {operator?.needsValue && (
                      <Input
                        value={rule.value ?? ''}
                        onChange={(e) => patch({ value: e.target.value })}
                        placeholder={
                          rule.subject === 'channel' ? 'whatsapp' : 'value'
                        }
                        className="bg-muted text-[12px]"
                      />
                    )}
                  </div>
                )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() =>
          set([...rules, { subject: 'contact_field', operator: 'equals' }])
        }
        className="text-muted-foreground hover:text-foreground border-border hover:border-primary/40 w-full rounded-md border border-dashed py-1.5 text-[11.5px]"
      >
        + Add rule
      </button>

      <p className="text-muted-foreground text-[11px] leading-relaxed">
        Values can carry tokens too — compare a contact field against{' '}
        <code className="font-mono">{'{{ steps.lookup.body.tier }}'}</code>.
        {groups.length > 0 ? '' : ''}
      </p>
    </>
  );
}

// ============================================================
// Data
// ============================================================

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function HttpRequestFields({ type, config, onChange, groups }: StepFieldsProps) {
  const method = (str(config.method) || 'POST').toUpperCase();
  const bodyMode =
    str(config.body_mode) || (config.body_template ? 'raw' : 'json');
  const auth = (config.auth as { type?: string } | undefined) ?? { type: 'none' };
  const hasBody = method !== 'GET' && method !== 'DELETE';

  return (
    <>
      {type === 'send_webhook' && (
        <p className="border-border text-muted-foreground rounded-md border border-dashed p-2 text-[11px] leading-relaxed">
          This is the older fire-and-forget step. It still works, but{' '}
          <strong className="text-foreground">HTTP request</strong> can read the
          response in later steps.
        </p>
      )}

      <div className="grid grid-cols-[92px_1fr] gap-2">
        <FieldBlock label="Method">
          <select
            value={method}
            onChange={(e) => onChange({ method: e.target.value })}
            className={SELECT_CLASS}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </FieldBlock>
        <TokenInput
          label="URL"
          value={str(config.url)}
          onChange={(v) => onChange({ url: v })}
          groups={groups}
          placeholder="https://api.example.com/orders/{{ contact.phone | digits }}"
        />
      </div>

      <KeyValueTable
        label="Query parameters"
        rows={(config.query as Record<string, unknown>) ?? {}}
        onChange={(next) => onChange({ query: next })}
        groups={groups}
        addLabel="Add parameter"
      />

      <FieldBlock label="Authentication">
        <select
          value={auth.type ?? 'none'}
          onChange={(e) => onChange({ auth: { type: e.target.value } })}
          className={SELECT_CLASS}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic (username + password)</option>
          <option value="header">Custom header</option>
        </select>
      </FieldBlock>
      <AuthFields auth={auth} onChange={onChange} groups={groups} />

      <KeyValueTable
        label="Headers"
        rows={(config.headers as Record<string, unknown>) ?? {}}
        onChange={(next) => onChange({ headers: next })}
        groups={groups}
        keyPlaceholder="content-type"
        addLabel="Add header"
      />

      {hasBody && (
        <>
          <FieldBlock label="Body">
            <select
              value={bodyMode}
              onChange={(e) => onChange({ body_mode: e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="json">JSON fields</option>
              <option value="form">Form fields</option>
              <option value="raw">Raw</option>
              <option value="none">No body</option>
            </select>
          </FieldBlock>

          {(bodyMode === 'json' || bodyMode === 'form') && (
            <KeyValueTable
              label={bodyMode === 'json' ? 'JSON fields' : 'Form fields'}
              rows={(config.body_fields as Record<string, unknown>) ?? {}}
              onChange={(next) => onChange({ body_fields: next })}
              groups={groups}
              keyPlaceholder="order_id"
              valuePlaceholder="{{ steps.lookup.body.id }}"
              addLabel="Add field"
              hint={
                bodyMode === 'json'
                  ? 'A field whose value is exactly one token keeps that token’s type — a number stays a number, an object stays an object.'
                  : undefined
              }
            />
          )}

          {bodyMode === 'raw' && (
            <TokenInput
              label="Raw body"
              multiline
              rows={6}
              mono
              value={str(config.body_template)}
              onChange={(v) => onChange({ body_template: v })}
              groups={groups}
              hint="Leave blank to send the whole run context. Use the | json filter around any token you paste inside quotes."
            />
          )}
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        <FieldBlock label="Timeout (seconds)">
          <Input
            type="number"
            min={1}
            max={30}
            value={Number(config.timeout_seconds ?? 10)}
            onChange={(e) =>
              onChange({ timeout_seconds: Number(e.target.value) })
            }
            className="bg-muted"
          />
        </FieldBlock>
        {type === 'http_request' && (
          <FieldBlock label="Non-2xx responses">
            <label className="flex h-8 items-center gap-2">
              <Switch
                checked={Boolean(config.ignore_http_errors)}
                onCheckedChange={(v) => onChange({ ignore_http_errors: !!v })}
              />
              <span className="text-muted-foreground text-[11.5px]">
                Treat as success
              </span>
            </label>
          </FieldBlock>
        )}
      </div>
      {type === 'http_request' && Boolean(config.ignore_http_errors) && (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          A 404 from “does this customer exist?” is an answer, not a failure —
          branch on <code className="font-mono">steps.…​.status</code> in a
          condition below.
        </p>
      )}
    </>
  );
}

function AuthFields({
  auth,
  onChange,
  groups,
}: {
  auth: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  groups: TokenGroup[];
}) {
  const set = (patch: Record<string, unknown>) =>
    onChange({ auth: { ...auth, ...patch } });

  if (auth.type === 'bearer') {
    return (
      <TokenInput
        label="Token"
        value={str(auth.token)}
        onChange={(v) => set({ token: v })}
        groups={groups}
        mono
        hint="Stored in this automation’s config — anyone who can edit it can read this."
      />
    );
  }
  if (auth.type === 'basic') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <FieldBlock label="Username">
          <Input
            value={str(auth.username)}
            onChange={(e) => set({ username: e.target.value })}
            className="bg-muted"
          />
        </FieldBlock>
        <FieldBlock label="Password">
          <Input
            type="password"
            value={str(auth.password)}
            onChange={(e) => set({ password: e.target.value })}
            className="bg-muted"
          />
        </FieldBlock>
      </div>
    );
  }
  if (auth.type === 'header') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <FieldBlock label="Header name">
          <Input
            value={str(auth.name)}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="x-api-key"
            className="bg-muted font-mono text-[12px]"
          />
        </FieldBlock>
        <FieldBlock label="Value">
          <Input
            value={str(auth.value)}
            onChange={(e) => set({ value: e.target.value })}
            className="bg-muted font-mono text-[12px]"
          />
        </FieldBlock>
      </div>
    );
  }
  return null;
}

function SetVariableFields({ config, onChange, groups }: StepFieldsProps) {
  // Seeded on mount only. The inspector remounts this component per step
  // (React key), so switching steps loads the right name without an
  // effect syncing it back — which would also fight the caret while
  // somebody is mid-word.
  const [nameDraft, setNameDraft] = useState(str(config.name));
  const invalid =
    nameDraft.length > 0 && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nameDraft);

  return (
    <>
      <FieldBlock
        label="Variable name"
        hint={
          invalid
            ? 'Letters, numbers and underscores only — it is addressed as {{ vars.name }}, and a dot or a space would split that path.'
            : 'Later steps read it as {{ vars.<name> }}.'
        }
      >
        <div className="flex items-center">
          <span className="bg-muted text-muted-foreground rounded-l-lg px-2 py-1.5 font-mono text-[11px]">
            vars.
          </span>
          <Input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => onChange({ name: nameDraft })}
            aria-invalid={invalid || undefined}
            className="bg-muted rounded-l-none font-mono text-[12px]"
          />
        </div>
      </FieldBlock>
      <TokenInput
        label="Value"
        value={str(config.value)}
        onChange={(v) => onChange({ value: v })}
        groups={groups}
        hint="A value that is exactly one token keeps its type — an object stays an object."
      />
    </>
  );
}

function StartFlowFields({ config, onChange }: StepFieldsProps) {
  const { flows } = useAutomationResources();
  const value = str(config.flow_id);
  const selected = flows.find((f) => f.id === value);
  return (
    <FieldBlock
      label="Flow"
      hint="Only active flows run. If the contact is already in a flow, this one is skipped rather than interrupting them."
    >
      <select
        value={value}
        onChange={(e) => onChange({ flow_id: e.target.value })}
        className={SELECT_CLASS}
      >
        <option value="">Select a flow…</option>
        {flows.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
            {f.status && f.status !== 'active' ? ` (${f.status})` : ''}
          </option>
        ))}
        {value && !selected && <option value={value}>{value} (unknown flow)</option>}
      </select>
    </FieldBlock>
  );
}

function RunAutomationFields({ config, onChange }: StepFieldsProps) {
  const { automations, currentAutomationId } = useAutomationResources();
  const value = str(config.automation_id);
  const options = automations.filter((a) => a.id !== currentAutomationId);
  return (
    <FieldBlock
      label="Automation"
      hint="Runs inline with this run’s data. Chains are limited to 3 deep, so a loop stops itself."
    >
      <select
        value={value}
        onChange={(e) => onChange({ automation_id: e.target.value })}
        className={SELECT_CLASS}
      >
        <option value="">Select an automation…</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name || 'Untitled'}
            {a.is_active ? '' : ' (inactive)'}
          </option>
        ))}
      </select>
    </FieldBlock>
  );
}
