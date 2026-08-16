'use client';

/**
 * Per-node forms for the node types added in the builder rebuild:
 * template, products, ask-location, ask-for-a-file, wait, API request,
 * set attribute, connect flow, and hand-to-AI-agent.
 *
 * They live here rather than in `node-config-form.tsx` because that file
 * was already 1,200 lines before any of this; the dispatcher there stays
 * the one place that maps a node type to its form.
 *
 * ⚠️ EVERY PICKER DEGRADES TO A TEXT INPUT.
 *   `useFlowResources()` returns empty lists on a fresh account or a
 *   failed request. A picker that renders nothing in that case would
 *   make the node unauthorable; the raw id a user types is the same
 *   string the dropdown would have set.
 */

import { Info, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { collectTemplateSlots } from '@/lib/whatsapp/template-slots';
import { useFlowResources } from '../flow-resources';
import { type BuilderNode } from '../shared';
import { NextNodeRow, TextRow } from './fields';

type Update = (patch: Record<string, unknown>) => void;

interface FormProps<C> {
  cfg: C;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: Update;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Small labelled block, matching the density of `fields.tsx`. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-muted-foreground mb-1 block text-xs">
        {label}
      </label>
      {children}
      {hint && <p className="text-muted-foreground mt-1 text-[10px]">{hint}</p>}
    </div>
  );
}

/** The one-line explainer used where a node's behaviour is surprising. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground bg-muted/50 flex items-start gap-1.5 rounded-md p-2 text-[11px] leading-relaxed">
      <Info className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// ============================================================
// send_template
// ============================================================

export interface SendTemplateCfg {
  template_name?: string;
  language?: string;
  body_params?: string[];
  next_node_key?: string;
}

export function SendTemplateForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: FormProps<SendTemplateCfg>) {
  const { templates } = useFlowResources();
  const name = str(cfg.template_name);
  const language = str(cfg.language);
  const params = Array.isArray(cfg.body_params) ? cfg.body_params : [];

  const selected = templates.find(
    (t) => t.name === name && (!language || t.language === language)
  );
  // How many {{n}} the chosen template's BODY actually has. Without a
  // synced template we cannot know, so we show whatever params are
  // already set and let the author fill them.
  //
  // Body only, deliberately: header media, header location and button
  // params are their own slot kinds with their own inputs in the
  // broadcast composer, and a flow node that pretended one text box
  // could fill them would send a broken template.
  const slotCount = selected
    ? collectTemplateSlots(selected).bodyVars.length
    : params.length;

  return (
    <>
      {templates.length === 0 ? (
        <Field
          label="Template name"
          hint="No approved templates synced yet — type the name exactly as it appears in WhatsApp Manager."
        >
          <Input
            value={name}
            onChange={(e) => onUpdateConfig({ template_name: e.target.value })}
            placeholder="order_confirmation"
            className="bg-muted font-mono text-xs"
          />
        </Field>
      ) : (
        <Field label="Template">
          <Select
            value={name && language ? `${name}::${language}` : ''}
            onValueChange={(v) => {
              const [nextName, nextLang] = (v ?? '').split('::');
              // Clearing the params is deliberate: they are positional,
              // so the previous template's copy would land in this
              // one's slots and send something nobody wrote.
              onUpdateConfig({
                template_name: nextName ?? '',
                language: nextLang ?? '',
                body_params: [],
              });
            }}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue placeholder="Select a template…" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem
                  key={`${t.name}::${t.language}`}
                  value={`${t.name}::${t.language}`}
                >
                  {t.name} · {t.language}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {templates.length === 0 && (
        <Field label="Language code">
          <Input
            value={language}
            onChange={(e) => onUpdateConfig({ language: e.target.value })}
            placeholder="en_US"
            className="bg-muted font-mono text-xs"
          />
        </Field>
      )}

      {slotCount > 0 && (
        <Field
          label="Variables"
          hint="Interpolated before sending — {{vars.name}} and {{contact.name}} both work."
        >
          <div className="flex flex-col gap-1.5">
            {Array.from({ length: slotCount }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-muted-foreground w-8 shrink-0 font-mono text-[11px]">
                  {`{{${i + 1}}}`}
                </span>
                <Input
                  value={params[i] ?? ''}
                  onChange={(e) => {
                    const next = [...params];
                    next[i] = e.target.value;
                    onUpdateConfig({ body_params: next });
                  }}
                  className="bg-muted text-xs"
                />
              </div>
            ))}
          </div>
        </Field>
      )}

      <Note>
        A template is the only message that sends after 24 hours of silence —
        which is what makes it the right node after a long wait.
      </Note>

      <NextNodeRow
        value={str(cfg.next_node_key)}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Advances to"
      />
    </>
  );
}

// ============================================================
// send_products
// ============================================================

export interface SendProductsCfg {
  mode?: 'single' | 'list';
  catalog_id?: string;
  product_retailer_ids?: string[];
  header_text?: string;
  body_text?: string;
  footer_text?: string;
  next_node_key?: string;
}

export function SendProductsForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: FormProps<SendProductsCfg>) {
  const { products } = useFlowResources();
  const mode = cfg.mode === 'list' ? 'list' : 'single';
  const ids = Array.isArray(cfg.product_retailer_ids)
    ? cfg.product_retailer_ids
    : [];

  const setIds = (next: string[]) =>
    onUpdateConfig({ product_retailer_ids: next });

  return (
    <>
      <Field label="Send">
        <Select
          value={mode}
          onValueChange={(v) => {
            // Dropping to a single product keeps the FIRST id rather
            // than clearing: the author picked it on purpose, and
            // silently emptying the list would look like a bug.
            const next = v === 'single' ? ids.slice(0, 1) : ids;
            onUpdateConfig({ mode: v, product_retailer_ids: next });
          }}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="single">One product</SelectItem>
            <SelectItem value="list">A list of products</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field
        label={mode === 'single' ? 'Product' : 'Products'}
        hint={
          products.length === 0
            ? 'No catalogue products synced — enter retailer IDs exactly as they appear in your Meta catalogue.'
            : undefined
        }
      >
        <div className="flex flex-col gap-1.5">
          {(ids.length > 0 ? ids : ['']).map((id, i) => (
            <div key={i} className="flex items-center gap-1.5">
              {products.length === 0 ? (
                <Input
                  value={id}
                  onChange={(e) => {
                    const next = [...(ids.length > 0 ? ids : [''])];
                    next[i] = e.target.value;
                    setIds(next);
                  }}
                  placeholder="SKU-1234"
                  className="bg-muted font-mono text-xs"
                />
              ) : (
                <Select
                  value={id || ''}
                  onValueChange={(v) => {
                    const next = [...(ids.length > 0 ? ids : [''])];
                    next[i] = v ?? '';
                    setIds(next);
                  }}
                >
                  <SelectTrigger className="bg-muted">
                    <SelectValue placeholder="Pick a product…" />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.retailer_id} value={p.retailer_id}>
                        {p.name} · {p.currency} {String(p.price)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {mode === 'list' && ids.length > 1 && (
                <button
                  type="button"
                  onClick={() => setIds(ids.filter((_, ix) => ix !== i))}
                  aria-label="Remove product"
                  className="text-muted-foreground hover:text-accent-red shrink-0 p-1"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          {mode === 'list' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIds([...ids, ''])}
              className="self-start"
            >
              <Plus className="h-3.5 w-3.5" />
              Add product
            </Button>
          )}
        </div>
      </Field>

      {mode === 'list' && (
        <>
          <TextRow
            label="Header"
            value={str(cfg.header_text)}
            onChange={(v) => onUpdateConfig({ header_text: v })}
          />
          <TextRow
            label="Body (required by WhatsApp)"
            value={str(cfg.body_text)}
            onChange={(v) => onUpdateConfig({ body_text: v })}
            rows={2}
          />
        </>
      )}

      <Field
        label="Catalogue ID (optional)"
        hint="Leave blank to use the catalogue connected to this WhatsApp account."
      >
        <Input
          value={str(cfg.catalog_id)}
          onChange={(e) => onUpdateConfig({ catalog_id: e.target.value })}
          className="bg-muted font-mono text-xs"
        />
      </Field>

      <NextNodeRow
        value={str(cfg.next_node_key)}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Advances to"
      />
    </>
  );
}

// ============================================================
// ask_location / ask_media
// ============================================================

export interface AskCfg {
  prompt_text?: string;
  var_key?: string;
  accept?: string;
  next_node_key?: string;
}

export function AskForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  kind,
}: FormProps<AskCfg> & { kind: 'location' | 'media' }) {
  return (
    <>
      <TextRow
        label="Prompt sent to the customer"
        value={str(cfg.prompt_text)}
        onChange={(v) => onUpdateConfig({ prompt_text: v })}
        rows={2}
      />

      {kind === 'media' && (
        <Field
          label="Accept"
          hint="Anything else the customer sends is treated as an unmatched reply and follows the flow's reprompt policy."
        >
          <Select
            value={cfg.accept ?? 'any'}
            onValueChange={(v) => onUpdateConfig({ accept: v })}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any file</SelectItem>
              <SelectItem value="image">Photos only</SelectItem>
              <SelectItem value="video">Videos only</SelectItem>
              <SelectItem value="document">Documents only</SelectItem>
              <SelectItem value="audio">Voice notes only</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field
        label="Variable key (stored in flow_runs.vars)"
        hint={
          kind === 'location'
            ? 'Saved as an object — read the parts with {{vars.KEY.latitude}} and {{vars.KEY.address}}.'
            : 'Saved as the file URL.'
        }
      >
        <Input
          value={str(cfg.var_key)}
          onChange={(e) =>
            onUpdateConfig({
              var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, ''),
            })
          }
          placeholder={kind === 'location' ? 'location' : 'file'}
          className="bg-muted font-mono text-xs"
        />
      </Field>

      <NextNodeRow
        value={str(cfg.next_node_key)}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="After capturing, advance to"
      />
    </>
  );
}

// ============================================================
// wait
// ============================================================

export interface WaitCfg {
  duration?: number;
  unit?: string;
  next_node_key?: string;
}

export function WaitForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: FormProps<WaitCfg>) {
  const duration = typeof cfg.duration === 'number' ? cfg.duration : 0;
  const unit = str(cfg.unit) || 'hours';
  const hours =
    unit === 'days'
      ? duration * 24
      : unit === 'minutes'
        ? duration / 60
        : duration;

  return (
    <>
      <Field label="Pause for">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            value={duration || ''}
            onChange={(e) =>
              onUpdateConfig({ duration: Number(e.target.value) || 0 })
            }
            className="bg-muted w-24"
          />
          <Select
            value={unit}
            onValueChange={(v) => onUpdateConfig({ unit: v })}
          >
            <SelectTrigger className="bg-muted flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">minutes</SelectItem>
              <SelectItem value="hours">hours</SelectItem>
              <SelectItem value="days">days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Field>

      {hours >= 24 ? (
        <Note>
          WhatsApp&apos;s 24-hour window keeps running while the flow waits.
          After this pause, only a <strong>template</strong> will send — unless
          the customer messages again first.
        </Note>
      ) : (
        <Note>
          The run is parked, not held open. Nothing is sent until the pause is
          over, and the customer can still reply in the meantime.
        </Note>
      )}

      <NextNodeRow
        value={str(cfg.next_node_key)}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Then continue to"
      />
    </>
  );
}

// ============================================================
// set_attribute
// ============================================================

export interface SetAttributeCfg {
  target?: string;
  key?: string;
  value?: string;
  next_node_key?: string;
}

const CONTACT_FIELDS = ['name', 'email', 'phone', 'company'] as const;

export function SetAttributeForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: FormProps<SetAttributeCfg>) {
  const { customFields } = useFlowResources();
  const target = str(cfg.target) || 'contact_field';
  const key = str(cfg.key);

  return (
    <>
      <Field label="Save to">
        <Select
          value={target}
          onValueChange={(v) =>
            // The key means something different per target, so carrying
            // it across would point at a field that does not exist.
            onUpdateConfig({ target: v, key: '' })
          }
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="contact_field">A contact field</SelectItem>
            <SelectItem value="custom_field">A custom field</SelectItem>
            <SelectItem value="var">A flow variable</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label={target === 'var' ? 'Variable name' : 'Field'}>
        {target === 'contact_field' ? (
          <Select value={key} onValueChange={(v) => onUpdateConfig({ key: v })}>
            <SelectTrigger className="bg-muted">
              <SelectValue placeholder="Pick a field…" />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_FIELDS.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : target === 'custom_field' && customFields.length > 0 ? (
          <Select value={key} onValueChange={(v) => onUpdateConfig({ key: v })}>
            <SelectTrigger className="bg-muted">
              <SelectValue placeholder="Pick a custom field…" />
            </SelectTrigger>
            <SelectContent>
              {customFields.map((f) => (
                <SelectItem key={f.id} value={f.field_name}>
                  {f.field_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={key}
            onChange={(e) =>
              onUpdateConfig({
                key: e.target.value.replace(/[^a-zA-Z0-9_]/g, ''),
              })
            }
            placeholder={target === 'var' ? 'order_id' : 'field_name'}
            className="bg-muted font-mono text-xs"
          />
        )}
      </Field>

      <Field
        label="Value"
        hint="Interpolated — {{vars.answer}} saves what a previous question captured. Leave blank to clear the field."
      >
        <Input
          value={str(cfg.value)}
          onChange={(e) => onUpdateConfig({ value: e.target.value })}
          placeholder="{{vars.answer}}"
          className="bg-muted font-mono text-xs"
        />
      </Field>

      <NextNodeRow
        value={str(cfg.next_node_key)}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Advances to"
      />
    </>
  );
}

// ============================================================
// http_request
// ============================================================

export interface HttpRequestCfg {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  response_var?: string;
  fail_on_error?: boolean;
  next_node_key?: string;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export function HttpRequestForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: FormProps<HttpRequestCfg>) {
  const method = str(cfg.method) || 'GET';
  const headers =
    cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {};
  const headerRows = Object.entries(headers);

  const setHeaders = (rows: [string, string][]) =>
    onUpdateConfig({
      headers: Object.fromEntries(rows.filter(([k]) => k.trim())),
    });

  return (
    <>
      <Field label="Request">
        <div className="flex items-center gap-2">
          <Select
            value={method}
            onValueChange={(v) => onUpdateConfig({ method: v })}
          >
            <SelectTrigger className="bg-muted w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={str(cfg.url)}
            onChange={(e) => onUpdateConfig({ url: e.target.value })}
            placeholder="https://api.example.com/orders/{{vars.order_id}}"
            className="bg-muted flex-1 font-mono text-xs"
          />
        </div>
      </Field>

      <Field label="Headers">
        <div className="flex flex-col gap-1.5">
          {headerRows.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={k}
                onChange={(e) => {
                  const next = [...headerRows] as [string, string][];
                  next[i] = [e.target.value, v];
                  setHeaders(next);
                }}
                placeholder="Authorization"
                className="bg-muted font-mono text-xs"
              />
              <Input
                value={v}
                onChange={(e) => {
                  const next = [...headerRows] as [string, string][];
                  next[i] = [k, e.target.value];
                  setHeaders(next);
                }}
                placeholder="Bearer …"
                className="bg-muted font-mono text-xs"
              />
              <button
                type="button"
                onClick={() =>
                  setHeaders(
                    headerRows.filter((_, ix) => ix !== i) as [string, string][]
                  )
                }
                aria-label="Remove header"
                className="text-muted-foreground hover:text-accent-red shrink-0 p-1"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setHeaders([...headerRows, ['', '']] as [string, string][])
            }
            className="self-start"
          >
            <Plus className="h-3.5 w-3.5" />
            Add header
          </Button>
        </div>
      </Field>

      {method !== 'GET' && (
        <Field label="Body" hint="Interpolated. JSON is the common case.">
          <Textarea
            value={str(cfg.body)}
            onChange={(e) => onUpdateConfig({ body: e.target.value })}
            rows={4}
            placeholder='{"phone": "{{contact.phone}}"}'
            className="bg-muted font-mono text-xs"
          />
        </Field>
      )}

      <Field
        label="Save the response as"
        hint="Read it downstream with {{vars.KEY.status}} and {{vars.KEY.body}}."
      >
        <Input
          value={str(cfg.response_var)}
          onChange={(e) =>
            onUpdateConfig({
              response_var: e.target.value.replace(/[^a-zA-Z0-9_]/g, ''),
            })
          }
          placeholder="api"
          className="bg-muted font-mono text-xs"
        />
      </Field>

      <div className="border-border flex items-center justify-between gap-3 rounded-md border p-2.5">
        <div>
          <p className="text-foreground text-xs font-medium">
            Stop the flow if the call fails
          </p>
          <p className="text-muted-foreground text-[10px]">
            Off by default — a status code is usually the thing you want to
            branch on with a condition.
          </p>
        </div>
        <Switch
          checked={Boolean(cfg.fail_on_error)}
          onCheckedChange={(v) => onUpdateConfig({ fail_on_error: Boolean(v) })}
        />
      </div>

      <NextNodeRow
        value={str(cfg.next_node_key)}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Advances to"
      />
    </>
  );
}

// ============================================================
// start_flow
// ============================================================

export interface StartFlowCfg {
  flow_id?: string;
}

export function StartFlowForm({
  cfg,
  onUpdateConfig,
}: {
  cfg: StartFlowCfg;
  onUpdateConfig: Update;
}) {
  const { flows } = useFlowResources();
  return (
    <>
      <Field
        label="Continue in"
        hint={
          flows.length === 0
            ? 'No other flows yet — paste a flow ID, or create the flow first.'
            : undefined
        }
      >
        {flows.length === 0 ? (
          <Input
            value={str(cfg.flow_id)}
            onChange={(e) => onUpdateConfig({ flow_id: e.target.value })}
            placeholder="flow id"
            className="bg-muted font-mono text-xs"
          />
        ) : (
          <Select
            value={str(cfg.flow_id)}
            onValueChange={(v) => onUpdateConfig({ flow_id: v })}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue placeholder="Pick a flow…" />
            </SelectTrigger>
            <SelectContent>
              {flows.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                  {f.status !== 'active' ? ` · ${f.status}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      <Note>
        This flow <strong>ends</strong> and the other one starts fresh — they
        don&apos;t nest, and the run does not come back here.
      </Note>
    </>
  );
}

// ============================================================
// ai_handoff
// ============================================================

export interface AiHandoffCfg {
  agent_id?: string;
  note?: string;
}

export function AiHandoffForm({
  cfg,
  onUpdateConfig,
}: {
  cfg: AiHandoffCfg;
  onUpdateConfig: Update;
}) {
  const { agents } = useFlowResources();
  const agentId = str(cfg.agent_id);

  return (
    <>
      <Field
        label="Agent"
        hint="Leave on “Whichever agent routing picks” unless this flow genuinely needs one specific agent — routing order is a workspace setting, and pinning one here quietly overrules it."
      >
        {agents.length === 0 ? (
          <p className="text-muted-foreground bg-muted/50 rounded-md p-2 text-[11px]">
            No AI agents yet. The conversation will be handed to whichever agent
            routing picks once you create one.
          </p>
        ) : (
          <Select
            value={agentId || '__auto__'}
            onValueChange={(v) =>
              onUpdateConfig({ agent_id: v === '__auto__' ? '' : v })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">
                Whichever agent routing picks
              </SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {a.is_active ? '' : ' · paused'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      <TextRow
        label="Note (context for the agent)"
        value={str(cfg.note)}
        onChange={(v) => onUpdateConfig({ note: v })}
        rows={2}
      />
    </>
  );
}
