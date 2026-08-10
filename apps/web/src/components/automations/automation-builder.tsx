"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  MessageSquare,
  FileText,
  Tag,
  TagIcon,
  UserCheck,
  PencilLine,
  Briefcase,
  Hourglass,
  GitBranch,
  Webhook,
  CircleSlash,
  Zap,
  Loader2,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  Calendar,
  Layers,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  AccountMember,
  Automation,
  AutomationStepType,
  AutomationTriggerType,
  ContactSegment,
  CustomField,
  KeywordMatchTriggerConfig,
  MessageTemplate,
  Tag as TagRecord,
} from "@/types"
import { createClient } from "@/lib/supabase/client"
import { collectTemplateSlots } from "@/lib/whatsapp/template-slots"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branches?: { yes: BuilderStep[]; no: BuilderStep[] }
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  /**
   * Channel restriction. Empty = run on all channels. Non-empty = only
   * these channels (e.g. ['instagram']). Mirrors automations.channels[] in DB.
   */
  channels: string[]
  is_active: boolean
  steps: BuilderStep[]
}

// ------------------------------------------------------------
// Step metadata — one source of truth for icon + label + border color
// ------------------------------------------------------------

interface StepMeta {
  label: string
  icon: typeof Zap
  /** Left-border accent color per spec. */
  border: string
}

const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: { label: "Send Message", icon: MessageSquare, border: "border-l-primary" },
  send_template: { label: "Send Template", icon: FileText, border: "border-l-primary" },
  add_tag: { label: "Add Tag", icon: Tag, border: "border-l-primary" },
  remove_tag: { label: "Remove Tag", icon: TagIcon, border: "border-l-primary" },
  add_to_segment: { label: "Add to Segment", icon: Layers, border: "border-l-primary" },
  remove_from_segment: { label: "Remove from Segment", icon: Layers, border: "border-l-primary" },
  assign_conversation: { label: "Assign Conversation", icon: UserCheck, border: "border-l-primary" },
  update_contact_field: { label: "Update Contact Field", icon: PencilLine, border: "border-l-primary" },
  create_deal: { label: "Create Deal", icon: Briefcase, border: "border-l-primary" },
  wait: { label: "Wait", icon: Hourglass, border: "border-l-border" },
  condition: { label: "Condition (If/Else)", icon: GitBranch, border: "border-l-amber-500" },
  send_webhook: { label: "Send Webhook", icon: Webhook, border: "border-l-primary" },
  close_conversation: { label: "Close Conversation", icon: CircleSlash, border: "border-l-primary" },
  send_form: { label: "Send Form", icon: FileText, border: "border-l-primary" },
  send_booking_link: { label: "Send Booking Link", icon: Calendar, border: "border-l-primary" },
}

const ADDABLE_STEPS: AutomationStepType[] = [
  "send_message",
  "send_template",
  "send_form",
  "send_booking_link",
  "add_tag",
  "remove_tag",
  "add_to_segment",
  "remove_from_segment",
  "assign_conversation",
  "update_contact_field",
  "create_deal",
  "wait",
  "condition",
  "send_webhook",
  "close_conversation",
]

const TRIGGER_OPTIONS: { value: AutomationTriggerType; label: string; hint: string; channelLock?: string }[] = [
  { value: "new_message_received", label: "New Message Received", hint: "Any incoming message" },
  {
    value: "first_inbound_message",
    label: "First Message from Contact",
    hint: "First time this contact ever messages you (works for manually-added contacts too)",
  },
  { value: "keyword_match", label: "Keyword Match", hint: "Message contains specific keyword(s)" },
  { value: "new_contact_created", label: "New Contact Created", hint: "When a contact is auto-created from an incoming message" },
  { value: "conversation_assigned", label: "Conversation Assigned", hint: "When assigned to an agent" },
  { value: "tag_added", label: "Tag Added", hint: "When a tag is added to a contact" },
  { value: "time_based", label: "Time-Based", hint: "On a recurring schedule" },
  {
    value: "instagram_comment",
    label: "Instagram Comment",
    hint: "When someone comments on one of your Instagram posts. Optionally filter by keyword. Instagram only.",
    channelLock: "instagram",
  },
  {
    value: "instagram_story_reply",
    label: "Instagram Story Reply",
    hint: "When someone replies to one of your Instagram stories. Optionally filter by keyword. Instagram only.",
    channelLock: "instagram",
  },
]

function cid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "" }
    case "send_template":
      return { template_name: "", language: "en_US", variables: {} }
    case "add_tag":
    case "remove_tag":
      return { tag_id: "" }
    case "add_to_segment":
    case "remove_from_segment":
      return { segment_id: "" }
    case "assign_conversation":
      return { mode: "round_robin" }
    case "update_contact_field":
      return { field: "name", value: "" }
    case "create_deal":
      return { pipeline_id: "", stage_id: "", title: "", value: 0 }
    case "wait":
      return { amount: 1, unit: "hours" }
    case "condition":
      return { subject: "tag_presence", operand: "", value: "" }
    case "send_webhook":
      return { url: "", headers: {}, body_template: "" }
    case "close_conversation":
      return {}
    default:
      return {}
  }
}

// ------------------------------------------------------------
// Account resources (tags, members, approved templates, pipelines)
//
// Loaded once at the builder root and shared via context so the
// tag / agent / template pickers below can offer existing resources
// by name instead of asking the user to paste raw UUIDs. Every picker
// falls back to a raw input when its list is empty (fresh account or
// an older deployment), so an automation is always authorable.
// ------------------------------------------------------------

interface AutomationResources {
  tags: TagRecord[]
  segments: ContactSegment[]
  members: AccountMember[]
  templates: MessageTemplate[]
  customFields: CustomField[]
  pipelines: PipelineOption[]
  stages: PipelineStageOption[]
  automations: Automation[]
  flows: FlowOption[]
}

export interface FlowOption {
  id: string
  name: string
  status?: string
  trigger_type: string
  trigger_config: Record<string, unknown>
}

interface PipelineOption {
  id: string
  name: string
}

interface PipelineStageOption {
  id: string
  name: string
  pipeline_id: string
  position: number
}

const ResourcesContext = createContext<AutomationResources>({
  tags: [],
  segments: [],
  members: [],
  templates: [],
  customFields: [],
  pipelines: [],
  stages: [],
  automations: [],
  flows: [],
})

function useResources(): AutomationResources {
  return useContext(ResourcesContext)
}

function ResourcesProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<TagRecord[]>([])
  const [segments, setSegments] = useState<ContactSegment[]>([])
  const [members, setMembers] = useState<AccountMember[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [pipelines, setPipelines] = useState<PipelineOption[]>([])
  const [stages, setStages] = useState<PipelineStageOption[]>([])
  const [automations, setAutomations] = useState<Automation[]>([])
  const [flows, setFlows] = useState<FlowOption[]>([])

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // Tags, templates and custom fields come straight from the DB — RLS
    // scopes them to the caller's account. Only APPROVED templates can
    // actually be sent (anything else 400s at send time), matching the
    // broadcast picker.
    void (async () => {
      const [
        tagsRes,
        segmentsRes,
        templatesRes,
        customFieldsRes,
        pipelinesRes,
        stagesRes,
      ] = await Promise.all([
          supabase.from("tags").select("*").order("name"),
          supabase.from("contact_segments").select("*").order("name"),
          supabase
            .from("message_templates")
            .select("*")
            .eq("status", "APPROVED")
            .order("name"),
          supabase.from("custom_fields").select("*").order("field_name"),
          supabase.from("pipelines").select("id, name").order("name"),
          supabase
            .from("pipeline_stages")
            .select("id, name, pipeline_id, position")
            .order("position"),
        ])
      if (cancelled) return
      setTags((tagsRes.data as TagRecord[] | null) ?? [])
      setSegments((segmentsRes.data as ContactSegment[] | null) ?? [])
      setTemplates((templatesRes.data as MessageTemplate[] | null) ?? [])
      setCustomFields((customFieldsRes.data as CustomField[] | null) ?? [])
      setPipelines((pipelinesRes.data as PipelineOption[] | null) ?? [])
      setStages((stagesRes.data as PipelineStageOption[] | null) ?? [])
    })()

    // Members go through the API so we inherit its email-visibility
    // rules (agents/viewers don't see emails).
    void (async () => {
      try {
        const res = await fetch("/api/account/members", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { members?: AccountMember[] }
        if (!cancelled) setMembers(json.members ?? [])
      } catch {
        // Members endpoint absent — caller falls back to raw input.
      }
    })()

    // Existing automations and flows for keyword conflict checking
    void (async () => {
      try {
        const res = await fetch("/api/automations", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { automations?: Automation[] }
        if (!cancelled) setAutomations(json.automations ?? [])
      } catch {
        // Optional
      }
    })()

    void (async () => {
      try {
        const res = await fetch("/api/flows", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { flows?: FlowOption[] }
        if (!cancelled) setFlows(json.flows ?? [])
      } catch {
        // Optional
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <ResourcesContext.Provider
      value={{
        tags,
        segments,
        members,
        templates,
        customFields,
        pipelines,
        stages,
        automations,
        flows,
      }}
    >
      {children}
    </ResourcesContext.Provider>
  )
}

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

/** Tag dropdown by name + color, storing the tag's id. Falls back to a
 *  raw id input when no tags exist yet. */
function TagSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { tags } = useResources()
  if (tags.length === 0) {
    return (
      <Input
        placeholder="Tag id"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = tags.find((t) => t.id === value)
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: selected?.color ?? "transparent" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">Select a tag…</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{value} (unknown tag)</option>
        )}
      </select>
    </div>
  )
}

/**
 * Segment dropdown for the add/remove-from-segment steps.
 *
 * Dynamic segments are listed but disabled rather than filtered out. The
 * engine refuses them at run time (a saved filter has no membership to
 * edit), and a segment silently missing from a dropdown reads as a bug,
 * whereas a greyed-out one with a reason is a rule you learn once.
 */
function SegmentSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { segments } = useResources()
  if (segments.length === 0) {
    return (
      <div className="space-y-1">
        <Input
          placeholder="Segment id"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-muted text-foreground"
        />
        <p className="text-xs text-muted-foreground">
          No segments yet — create one from Contacts → Segments.
        </p>
      </div>
    )
  }
  const selected = segments.find((s) => s.id === value)
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span
          className="h-3 w-3 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: selected?.color ?? "transparent" }}
          aria-hidden
        />
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">Select a segment…</option>
          {segments.map((s) => (
            <option
              key={s.id}
              value={s.id}
              disabled={s.kind === "dynamic"}
            >
              {s.name}
              {s.kind === "dynamic" ? " (filter — members are automatic)" : ""}
            </option>
          ))}
          {/* Preserve a saved segment that's since been deleted, so
              editing an old automation doesn't silently drop it. */}
          {value && !selected && (
            <option value={value}>{value} (unknown segment)</option>
          )}
        </select>
      </div>
      {selected?.kind === "dynamic" && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          This is a filter segment. Its members are worked out from its rules,
          so this step will fail at run time.
        </p>
      )}
    </div>
  )
}

/** Contact-field dropdown for "Update Contact Field": built-in columns plus
 *  any account custom fields (stored as `custom:<id>`). A saved custom field
 *  that's since been deleted is preserved as a labelled option so editing an
 *  existing automation doesn't silently drop it. */
function ContactFieldSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { customFields } = useResources()
  const customValue = value.startsWith("custom:") ? value : ""
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue)
  return (
    <select
      value={value || "name"}
      onChange={(e) => onChange(e.target.value)}
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
      {customValue && !knownCustom && (
        <option value={customValue}>{customValue} (unknown field)</option>
      )}
    </select>
  )
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
function AgentSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { members } = useResources()
  if (members.length === 0) {
    return (
      <Input
        placeholder="Agent id"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = members.find((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">Select an agent…</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && (
        <option value={value}>{value} (unknown agent)</option>
      )}
    </select>
  )
}

/** Pipeline + stage picker for Create Deal. The automation stores ids because
 *  the engine writes directly to deals, but authors should choose by name. */
function DealPipelineFields({
  pipelineId,
  stageId,
  onChange,
}: {
  pipelineId: string
  stageId: string
  onChange: (patch: { pipeline_id: string; stage_id: string }) => void
}) {
  const { pipelines, stages } = useResources()

  if (pipelines.length === 0) {
    return (
      <>
        <FieldBlock label="Pipeline id">
          <Input
            value={pipelineId}
            onChange={(e) =>
              onChange({ pipeline_id: e.target.value, stage_id: stageId })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label="Stage id">
          <Input
            value={stageId}
            onChange={(e) =>
              onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId)
  const stageOptions = stages.filter((s) => s.pipeline_id === pipelineId)
  const selectedStage = stageOptions.find((s) => s.id === stageId)

  return (
    <>
      <FieldBlock label="Pipeline">
        <select
          value={pipelineId}
          onChange={(e) => {
            const nextPipelineId = e.target.value
            const firstStage = stages.find(
              (s) => s.pipeline_id === nextPipelineId
            )
            onChange({
              pipeline_id: nextPipelineId,
              stage_id: firstStage?.id ?? "",
            })
          }}
          className={SELECT_CLASS}
        >
          <option value="">Select a pipeline…</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {pipelineId && !selectedPipeline && (
            <option value={pipelineId}>{pipelineId} (unknown pipeline)</option>
          )}
        </select>
      </FieldBlock>
      <FieldBlock label="Stage">
        <select
          value={stageId}
          onChange={(e) =>
            onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
          }
          className={SELECT_CLASS}
          disabled={!pipelineId || stageOptions.length === 0}
        >
          <option value="">
            {pipelineId ? "Select a stage…" : "Select a pipeline first…"}
          </option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {stageId && pipelineId && !selectedStage && (
            <option value={stageId}>{stageId} (unknown stage)</option>
          )}
        </select>
      </FieldBlock>
    </>
  )
}

/** Template dropdown showing approved templates by name + language,
 *  storing both template_name and language. Falls back to manual name +
 *  language inputs when no approved templates are synced yet. */
/** Substitute the configured values into the body for a live preview. */
function previewTemplateBody(
  template: MessageTemplate,
  variables: Record<string, string>,
): string {
  return (template.body_text ?? "").replace(
    /\{\{\s*([^{}]+?)\s*\}\}/g,
    (whole, key: string) => variables[key]?.trim() || whole,
  )
}

function SendTemplateFields({
  templateName,
  language,
  config,
  onChange,
}: {
  templateName: string
  language: string
  /** The whole send_template step config — header and button values live here too. */
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const variables = (config.variables as Record<string, string>) ?? {}
  const buttonParams = (config.button_params as Record<string, string>) ?? {}
  const headerLocation =
    (config.header_location as {
      latitude?: string
      longitude?: string
      name?: string
      address?: string
    }) ?? {}
  const { templates } = useResources()

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock label="Template name">
          <Input
            value={templateName}
            onChange={(e) =>
              onChange({ template_name: e.target.value, language })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label="Language">
          <Input
            value={language}
            onChange={(e) =>
              onChange({ template_name: templateName, language: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  // Encode name + language in the option value so two templates that
  // share a name across languages stay distinct.
  const toValue = (name: string, lang: string) => `${name}::${lang}`
  const current = templateName ? toValue(templateName, language) : ""
  const hasMatch = templates.some(
    (t) => toValue(t.name, t.language ?? "en_US") === current,
  )

  const selected = templates.find(
    (t) => toValue(t.name, t.language ?? "en_US") === current,
  )
  // Same collector the inbox picker uses, so an automation asks for
  // exactly what a manual send would — including the header pin and
  // button substitutions a template can require beyond its body.
  const slots = selected ? collectTemplateSlots(selected) : null
  const variableKeys = slots?.bodyVars ?? []

  return (
    <>
      <FieldBlock label="Template">
        <select
          value={current}
          onChange={(e) => {
            const [name, lang] = e.target.value.split("::")
            // Drop the old values: they were positioned against a
            // different template's placeholders, and carrying them over
            // would silently send last template's copy in this one's
            // slots.
            onChange({
              template_name: name ?? "",
              language: lang ?? "",
              variables: {},
              button_params: {},
              header_text: "",
              header_media_url: "",
              header_location: undefined,
            })
          }}
          className={SELECT_CLASS}
        >
          <option value="">Select a template…</option>
          {templates.map((t) => {
            const lang = t.language ?? "en_US"
            return (
              <option key={t.id} value={toValue(t.name, lang)}>
                {t.name} ({lang})
              </option>
            )
          })}
          {current && !hasMatch && (
            <option value={current}>
              {templateName} ({language || "unknown"}) — not in approved list
            </option>
          )}
        </select>
      </FieldBlock>

      {/* A template's requirements are not limited to its body. Meta
          rejects the whole send when any of these is missing, so an
          automation has to be able to supply them — same slots the
          inbox picker collects. */}
      {slots?.headerTextVars.length ? (
        <FieldBlock label="Header variable">
          <Input
            value={(config.header_text as string) ?? ""}
            onChange={(e) => onChange({ header_text: e.target.value })}
            placeholder="Text, or {{contact.name}}"
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      ) : null}

      {slots?.headerMedia && (
        <FieldBlock
          label={`${slots.headerMedia.kind.charAt(0)}${slots.headerMedia.kind
            .slice(1)
            .toLowerCase()} header URL`}
        >
          <Input
            value={(config.header_media_url as string) ?? ""}
            onChange={(e) => onChange({ header_media_url: e.target.value })}
            placeholder={
              slots.headerMedia.hasDefault
                ? "Leave blank to use the template's media"
                : "https://…"
            }
            className="bg-muted text-foreground"
          />
          {!slots.headerMedia.hasDefault && (
            <p className="mt-1 text-[11px] text-amber-500">
              This template has no media saved, so a URL is required for
              every send.
            </p>
          )}
        </FieldBlock>
      )}

      {slots?.headerLocation && (
        <FieldBlock label="Location header">
          <div className="flex flex-col gap-2">
            <p className="text-[11px] text-muted-foreground">
              WhatsApp shows a map pin above the message. All four fields
              are required — Meta rejects the send without them.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={headerLocation.latitude ?? ""}
                onChange={(e) =>
                  onChange({
                    header_location: {
                      ...headerLocation,
                      latitude: e.target.value,
                    },
                  })
                }
                placeholder="Latitude"
                className="bg-muted text-foreground"
              />
              <Input
                value={headerLocation.longitude ?? ""}
                onChange={(e) =>
                  onChange({
                    header_location: {
                      ...headerLocation,
                      longitude: e.target.value,
                    },
                  })
                }
                placeholder="Longitude"
                className="bg-muted text-foreground"
              />
            </div>
            <Input
              value={headerLocation.name ?? ""}
              onChange={(e) =>
                onChange({
                  header_location: { ...headerLocation, name: e.target.value },
                })
              }
              placeholder="Place name"
              className="bg-muted text-foreground"
            />
            <Input
              value={headerLocation.address ?? ""}
              onChange={(e) =>
                onChange({
                  header_location: {
                    ...headerLocation,
                    address: e.target.value,
                  },
                })
              }
              placeholder="Address"
              className="bg-muted text-foreground"
            />
            {(!headerLocation.latitude?.trim() ||
              !headerLocation.longitude?.trim() ||
              !headerLocation.name?.trim() ||
              !headerLocation.address?.trim()) && (
              <p className="text-[11px] text-amber-500">
                All four fields are required — WhatsApp rejects a
                location header that is missing any of them.
              </p>
            )}
          </div>
        </FieldBlock>
      )}

      {/* One input per placeholder in the template body. Without these
          a template with variables could not be used from an automation
          at all: the executor reads `variables`, and nothing wrote it. */}
      {variableKeys.length > 0 && (
        <FieldBlock label="Template variables">
          <div className="flex flex-col gap-2">
            {variableKeys.map((key) => {
              // Meta counts parameters, so a blank one is not "send it
              // empty" — it fails the whole send at runtime with
              // "number of parameters does not match". Flag it here,
              // where it can still be fixed.
              const empty = !(variables[key] ?? "").trim()
              return (
                <div key={key} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate font-mono text-xs text-muted-foreground">
                    {`{{${key}}}`}
                  </span>
                  <Input
                    value={variables[key] ?? ""}
                    onChange={(e) =>
                      onChange({
                        variables: { ...variables, [key]: e.target.value },
                      })
                    }
                    placeholder="Text, or {{contact.name}}"
                    className={cn(
                      "bg-muted text-foreground",
                      empty && "border-amber-500/60",
                    )}
                  />
                </div>
              )
            })}
            {variableKeys.some((k) => !(variables[k] ?? "").trim()) && (
              <p className="text-[11px] text-amber-500">
                Every variable needs a value — WhatsApp rejects a template
                send whose parameter count doesn&apos;t match.
              </p>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Values can be plain text or a token resolved when the
              automation runs:{" "}
              <code className="font-mono">{"{{contact.name}}"}</code>,{" "}
              <code className="font-mono">{"{{contact.phone}}"}</code>,{" "}
              <code className="font-mono">{"{{contact.email}}"}</code>,{" "}
              <code className="font-mono">{"{{contact.company}}"}</code>,{" "}
              <code className="font-mono">{"{{message.text}}"}</code>. An
              unknown token resolves to nothing.
            </p>
          </div>
        </FieldBlock>
      )}

      {(slots?.urlButtons.length || slots?.copyCodeButtons.length) ? (
        <FieldBlock label="Button values">
          <div className="flex flex-col gap-2">
            {slots.urlButtons.map((slot) => (
              <div key={`url-${slot.index}`} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {slot.text}
                </span>
                <Input
                  value={buttonParams[String(slot.index)] ?? ""}
                  onChange={(e) =>
                    onChange({
                      button_params: {
                        ...buttonParams,
                        [String(slot.index)]: e.target.value,
                      },
                    })
                  }
                  placeholder={`Value for {{${slot.token}}} in the URL`}
                  className="bg-muted text-foreground"
                />
              </div>
            ))}
            {slots.copyCodeButtons.map((slot) => (
              <div key={`copy-${slot.index}`} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {slot.text}
                </span>
                <Input
                  value={buttonParams[String(slot.index)] ?? ""}
                  onChange={(e) =>
                    onChange({
                      button_params: {
                        ...buttonParams,
                        [String(slot.index)]: e.target.value,
                      },
                    })
                  }
                  placeholder="Coupon code"
                  className="bg-muted text-foreground"
                />
              </div>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {selected?.body_text && (
        <FieldBlock label="Preview">
          <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-foreground">
            {previewTemplateBody(selected, variables)}
          </p>
        </FieldBlock>
      )}
    </>
  )
}

// ------------------------------------------------------------
// Main builder component
// ------------------------------------------------------------

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter()
  const isEditing = !!initial.id
  const [state, setState] = useState<BuilderInitial>(initial)
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function patchTop<K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  // --- Step tree mutations (immutable) ---

  function updateStep(path: StepPath, updater: (s: BuilderStep) => BuilderStep) {
    setState((s) => ({ ...s, steps: mapAtPath(s.steps, path, updater) }))
  }

  function addStepAt(parent: ParentScope, index: number, type: AutomationStepType) {
    const node: BuilderStep = {
      cid: cid(),
      step_type: type,
      step_config: blankConfig(type),
      branches: type === "condition" ? { yes: [], no: [] } : undefined,
    }
    setState((s) => ({ ...s, steps: insertAt(s.steps, parent, index, node) }))
    setExpandedId(node.cid)
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeAt(s.steps, path) }))
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveAt(s.steps, path, direction) }))
  }

  async function save() {
    setSaving(true)
    try {
      const payload = {
        name: state.name || "Untitled automation",
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        channels: state.channels,
        is_active: state.is_active,
        steps: toApiSteps(state.steps),
      }

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // If the server blocked activation with validation issues,
        // surface the first concrete problem so the user can fix it
        // without opening DevTools for the full array.
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0]
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path ? `at ${firstIssue.path}` : undefined,
          })
        } else {
          toast.error(body?.error ?? "Save failed")
        }
        return
      }
      toast.success(isEditing ? "Automation saved" : "Automation created")
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Top bar. At sub-sm widths the "Active" label is hidden and the
          switch moves to the right of the save button, so the name input
          gets maximum width. */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Back to automations"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patchTop("name", e.target.value)}
          placeholder="Untitled automation"
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:bg-muted focus:outline-none sm:text-base"
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">Active</span>
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => patchTop("is_active", !!v)}
            aria-label="Active"
          />
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? "Save" : "Save Draft"}
        </Button>
      </header>

      {/* Canvas */}
      <div className="relative flex-1 overflow-y-auto">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:20px_20px] pointer-events-none" />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-0 px-4 py-10">
          <ResourcesProvider>
            <TriggerCard
              type={state.trigger_type}
              config={state.trigger_config}
              channels={state.channels}
              currentAutomationId={initial.id}
              onTypeChange={(t) => {
                // IG-only triggers auto-lock the automation to Instagram so
                // the user doesn't have to set it manually.
                const lock = TRIGGER_OPTIONS.find((o) => o.value === t)?.channelLock
                patchTop("trigger_type", t)
                if (lock) patchTop("channels", [lock])
              }}
              onConfigChange={(c) => patchTop("trigger_config", c)}
              onChannelsChange={(ch) => patchTop("channels", ch)}
            />
            <StepList
              steps={state.steps}
              parentPath={[]}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
              updateStep={updateStep}
              addStepAt={addStepAt}
              deleteStepAt={deleteStepAt}
              moveStepAt={moveStepAt}
            />
          </ResourcesProvider>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Trigger card
// ------------------------------------------------------------

export interface KeywordConflict {
  keyword: string
  sourceType: "automation" | "flow"
  id: string
  name: string
}

function findKeywordConflicts(
  currentAutomationId: string | undefined,
  currentKeywords: string[],
  automations: Automation[],
  flows: FlowOption[],
): KeywordConflict[] {
  if (!currentKeywords || currentKeywords.length === 0) return []

  const normalizedCurrent = currentKeywords
    .map((k) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
    .filter(Boolean)
  if (normalizedCurrent.length === 0) return []

  const conflicts: KeywordConflict[] = []
  const seenKey = new Set<string>()

  // Check Automations
  for (const aut of automations) {
    if (currentAutomationId && aut.id === currentAutomationId) continue
    const trigType = aut.trigger_type
    if (
      trigType === "keyword_match" ||
      trigType === "instagram_comment" ||
      trigType === "instagram_story_reply"
    ) {
      const cfg = aut.trigger_config as { keywords?: string[] }
      const existingKeywords = (cfg?.keywords ?? []).map((k) =>
        typeof k === "string" ? k.trim().toLowerCase() : "",
      )
      for (const kw of normalizedCurrent) {
        if (existingKeywords.includes(kw)) {
          const key = `automation::${aut.id}::${kw}`
          if (!seenKey.has(key)) {
            seenKey.add(key)
            conflicts.push({
              keyword: kw,
              sourceType: "automation",
              id: aut.id,
              name: aut.name || "Untitled automation",
            })
          }
        }
      }
    }
  }

  // Check Flows
  for (const fl of flows) {
    if (fl.trigger_type === "keyword") {
      const cfg = fl.trigger_config as { keywords?: string[] }
      const existingKeywords = (cfg?.keywords ?? []).map((k) =>
        typeof k === "string" ? k.trim().toLowerCase() : "",
      )
      for (const kw of normalizedCurrent) {
        if (existingKeywords.includes(kw)) {
          const key = `flow::${fl.id}::${kw}`
          if (!seenKey.has(key)) {
            seenKey.add(key)
            conflicts.push({
              keyword: kw,
              sourceType: "flow",
              id: fl.id,
              name: fl.name || "Untitled flow",
            })
          }
        }
      }
    }
  }

  return conflicts
}

function KeywordWarningBanner({ conflicts }: { conflicts: KeywordConflict[] }) {
  if (conflicts.length === 0) return null

  return (
    <div className="mt-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 shadow-sm">
      <div className="flex items-center gap-1.5 font-semibold text-amber-400">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
        Keyword conflict warning
      </div>
      <p className="mt-1 text-[11px] leading-normal text-amber-200/90">
        The keyword(s) below already exist in active workflows. Duplicate keywords can trigger multiple automations or flows simultaneously:
      </p>
      <div className="mt-2 space-y-1">
        {conflicts.map((c, idx) => (
          <div key={idx} className="flex items-center gap-1.5 text-[11px]">
            <span className="font-mono font-medium text-amber-300">"{c.keyword}"</span>
            <span className="text-amber-200/70">is used in {c.sourceType === "automation" ? "Automation" : "Flow"}:</span>
            <span className="font-medium text-amber-300 truncate max-w-[140px]">{c.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function KeywordWarningBannerWrapper({
  currentAutomationId,
  config,
}: {
  currentAutomationId?: string
  config: KeywordMatchTriggerConfig
}) {
  const { automations, flows } = useResources()
  const rawKeywords = config?.keywords ?? []
  const conflicts = useMemo(
    () =>
      findKeywordConflicts(
        currentAutomationId,
        rawKeywords,
        automations,
        flows,
      ),
    [currentAutomationId, rawKeywords, automations, flows],
  )
  return <KeywordWarningBanner conflicts={conflicts} />
}

function TriggerCard({
  type,
  config,
  channels,
  currentAutomationId,
  onTypeChange,
  onConfigChange,
  onChannelsChange,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  channels: string[]
  currentAutomationId?: string
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
  onChannelsChange: (ch: string[]) => void
}) {
  /** Channels available in this picker. Must match CHANNEL_IDS in channels.ts. */
  const CHANNEL_OPTS = [
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'instagram', label: 'Instagram' },
    { value: 'web', label: 'Web' },
  ] as const

  const channelLock = TRIGGER_OPTIONS.find((o) => o.value === type)?.channelLock
  const [open, setOpen] = useState(false)
  return (
    // Card width: full on mobile, fixed 320px on sm+. The canvas wrapper
    // (max-w-2xl + px-4) keeps this tidy on tablet/desktop.
    <div className="z-10 w-full max-w-[320px] sm:w-80">
      <div className="rounded-lg border border-border border-l-4 border-l-blue-500 bg-card shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-blue-300">Trigger</div>
            <div className="truncate text-sm font-medium text-foreground">
              {TRIGGER_OPTIONS.find((o) => o.value === type)?.label ?? type}
            </div>
          </div>
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="space-y-3 border-t border-border px-4 py-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Trigger type
              </label>
              <select
                value={type}
                onChange={(e) => onTypeChange(e.target.value as AutomationTriggerType)}
                className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                {TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {TRIGGER_OPTIONS.find((o) => o.value === type)?.hint}
              </p>
            </div>

            {/* "From" channel picker */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                From
              </label>
              {channelLock ? (
                <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1.5">
                  <span className="text-xs capitalize text-foreground">{channelLock}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">locked by trigger</span>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {CHANNEL_OPTS.map((ch) => {
                    const active = channels.includes(ch.value)
                    return (
                      <button
                        key={ch.value}
                        type="button"
                        onClick={() => {
                          const next = active
                            ? channels.filter((c) => c !== ch.value)
                            : [...channels, ch.value]
                          onChannelsChange(next)
                        }}
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                          active
                            ? "border-primary/50 bg-primary/15 text-primary"
                            : "border-border bg-muted text-muted-foreground hover:border-border hover:text-foreground",
                        )}
                        aria-pressed={active}
                      >
                        {ch.label}
                      </button>
                    )
                  })}
                  {channels.length === 0 && (
                    <span className="text-[11px] text-muted-foreground">All channels (default)</span>
                  )}
                </div>
              )}
            </div>

            {(type === "keyword_match" || type === "instagram_comment" || type === "instagram_story_reply") && (
              <>
                <KeywordMatchConfig
                  config={config as unknown as KeywordMatchTriggerConfig}
                  onChange={onConfigChange}
                />
                <KeywordWarningBannerWrapper
                  currentAutomationId={currentAutomationId}
                  config={config as unknown as KeywordMatchTriggerConfig}
                />
              </>
            )}
            {type === "tag_added" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Tag
                </label>
                <TagSelect
                  value={(config.tag_id as string) ?? ""}
                  onChange={(v) => onConfigChange({ ...config, tag_id: v })}
                />
              </div>
            )}
            {type === "time_based" && (
              <Input
                placeholder="Cron expression or HH:mm"
                value={(config.schedule as string) ?? ""}
                onChange={(e) =>
                  onConfigChange({ ...config, schedule: e.target.value })
                }
                className="bg-muted text-foreground"
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function KeywordMatchConfig({
  config,
  onChange,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
}) {
  const keywords = config?.keywords ?? []
  // Keep a local draft string so the comma and trailing space aren't
  // stripped on every keystroke (which made multi-word, comma-separated
  // entry like "SEO, search engine optimization" impossible to type).
  // We only parse into the keywords array on blur, then re-display the
  // cleaned, rejoined form. Seeded once on mount; this component remounts
  // when the trigger type changes, so the seed stays in sync.
  const [draft, setDraft] = useState(keywords.join(", "))

  // Persist the default the <select> displays. The dropdown falls back to
  // "contains" for display, but leaving it untouched would otherwise omit
  // match_type from the saved config — and activation validation then
  // rejected it (trigger.match_type). Seed once on mount; the component
  // remounts when the trigger type changes, matching the keywords draft.
  useEffect(() => {
    if (config?.match_type == null) {
      onChange({ ...config, match_type: "contains" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, keywords: parsed })
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Keywords (comma-separated)
        </label>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder="e.g. pricing, demo request, talk to sales"
          className="bg-muted text-foreground"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Match type
        </label>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) => onChange({ ...config, match_type: e.target.value as "exact" | "contains" })}
          className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:outline-none"
        >
          <option value="contains">Contains</option>
          <option value="exact">Exact</option>
        </select>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Step list + card + connectors
// ------------------------------------------------------------

type ParentScope =
  | { kind: "root" }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no" }

type StepPath = (
  | { kind: "root"; index: number }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no"; index: number }
)[]

interface StepListProps {
  steps: BuilderStep[]
  parentPath: StepPath
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  updateStep: (path: StepPath, updater: (s: BuilderStep) => BuilderStep) => void
  addStepAt: (parent: ParentScope, index: number, type: AutomationStepType) => void
  deleteStepAt: (path: StepPath) => void
  moveStepAt: (path: StepPath, direction: -1 | 1) => void
}

function StepList(props: StepListProps) {
  const { steps, parentPath, ...rest } = props
  const parentScope: ParentScope =
    parentPath.length === 0
      ? { kind: "root" }
      : (() => {
          const last = parentPath[parentPath.length - 1]
          if (last.kind !== "branch") return { kind: "root" } as const
          return { kind: "branch", parentCid: last.parentCid, branch: last.branch } as const
        })()

  return (
    <div className="flex flex-col items-center">
      <AddButton onPick={(t) => props.addStepAt(parentScope, 0, t)} />
      {steps.map((step, idx) => (
        <StepRenderer
          key={step.cid}
          step={step}
          index={idx}
          total={steps.length}
          parentScope={parentScope}
          parentPath={parentPath}
          {...rest}
        />
      ))}
    </div>
  )
}

function StepRenderer({
  step,
  index,
  total,
  parentScope,
  parentPath,
  ...props
}: {
  step: BuilderStep
  index: number
  total: number
  parentScope: ParentScope
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const path: StepPath = [
    ...parentPath,
    parentScope.kind === "root"
      ? { kind: "root", index }
      : { kind: "branch", parentCid: parentScope.parentCid, branch: parentScope.branch, index },
  ]
  const meta = STEP_META[step.step_type]
  const Icon = meta.icon
  const expanded = props.expandedId === step.cid
  const isCondition = step.step_type === "condition"
  // Card widths on mobile fill the full canvas column (max-w-2xl px-4
  // still keeps them reasonable). On sm+ the original fixed widths
  // come back so the flow visual stays recognisable.
  const width = isCondition
    ? "w-full max-w-[400px] sm:w-[400px]"
    : "w-full max-w-[320px] sm:w-80"

  return (
    <>
      <div className={cn("z-10 flex flex-col", width)}>
        <div
          className={cn(
            "rounded-lg border border-border border-l-4 bg-card shadow-lg",
            meta.border,
          )}
        >
          <button
            type="button"
            onClick={() => props.setExpandedId(expanded ? null : step.cid)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <GripVertical className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {isCondition ? "Condition" : step.step_type === "wait" ? "Wait" : "Action"}
              </div>
              <div className="truncate text-sm font-medium text-foreground">{meta.label}</div>
              <div className="truncate text-[11px] text-muted-foreground">{previewFor(step)}</div>
            </div>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")}
            />
          </button>
          {expanded && (
            <div className="border-t border-border px-4 py-3">
              <StepEditor
                step={step}
                onChange={(next) => props.updateStep(path, () => next)}
              />
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    aria-label="Move up"
                    onClick={() => props.moveStepAt(path, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === total - 1}
                    aria-label="Move down"
                    onClick={() => props.moveStepAt(path, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => props.deleteStepAt(path)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>

        {isCondition && (
          <ConditionBranches step={step} parentPath={path} {...props} />
        )}
      </div>

      {/* A condition branches into Yes/No (rendered above by
          ConditionBranches), so it has no linear "continue" path — adding
          the trailing connector here would produce a spurious third output. */}
      {!isCondition && (
        <AddButton
          onPick={(t) => props.addStepAt(parentScope, index + 1, t)}
        />
      )}
    </>
  )
}

function ConditionBranches({
  step,
  parentPath,
  ...props
}: {
  step: BuilderStep
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const yes = step.branches?.yes ?? []
  const no = step.branches?.no ?? []
  // Build the child scope by appending a branch marker. The scope the
  // StepList uses is driven by the LAST element of parentPath, so the
  // tail's `index` doesn't matter — it's replaced per child during walks.
  const yesPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "yes", index: 0 },
  ]
  const noPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "no", index: 0 },
  ]
  return (
    // Stack Yes/No vertically on mobile — two columns at 375px would
    // cram each branch to ~170px which is too narrow for the nested
    // cards. Two-column grid returns on sm+.
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <BranchColumn label="Yes" color="text-primary">
        <StepList {...props} steps={yes} parentPath={yesPath} />
      </BranchColumn>
      <BranchColumn label="No" color="text-rose-400">
        <StepList {...props} steps={no} parentPath={noPath} />
      </BranchColumn>
    </div>
  )
}

function BranchColumn({
  label,
  color,
  children,
}: {
  label: string
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center">
      <div className={cn("mb-2 text-[11px] font-semibold uppercase", color)}>{label}</div>
      {children}
    </div>
  )
}

function AddButton({ onPick }: { onPick: (t: AutomationStepType) => void }) {
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-4 w-[2px] bg-border" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary data-[popup-open]:border-primary data-[popup-open]:bg-primary/20 data-[popup-open]:text-primary"
          aria-label="Add step"
        >
          <Plus className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-80 min-w-56 overflow-y-auto border-border bg-popover"
        >
          {ADDABLE_STEPS.map((t) => {
            const Icon = STEP_META[t].icon
            return (
              <DropdownMenuItem key={t} onClick={() => onPick(t)}>
                <Icon className="h-4 w-4" />
                {STEP_META[t].label}
                {t === "send_template" && (
                  <span className="ml-auto text-[10px] font-medium text-muted-foreground opacity-60">
                    WA only
                  </span>
                )}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-4 w-[2px] bg-border" aria-hidden />
    </div>
  )
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (s: BuilderStep) => void
}) {
  const cfg = step.step_config
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } })

  switch (step.step_type) {
    case "send_message":
      return (
        <FieldBlock label="Message text">
          <Textarea
            value={(cfg.text as string) ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            placeholder="Hi! Thanks for reaching out…"
            className="min-h-24 bg-muted text-foreground"
          />
        </FieldBlock>
      )
    case "send_template":
      return (
        <SendTemplateFields
          templateName={(cfg.template_name as string) ?? ""}
          language={(cfg.language as string) ?? ""}
          config={cfg}
          onChange={(patch) => set(patch)}
        />
      )
    case "add_to_segment":
    case "remove_from_segment":
      return (
        <FieldBlock label="Segment">
          <SegmentSelect
            value={(cfg.segment_id as string) ?? ""}
            onChange={(v) => set({ segment_id: v })}
          />
        </FieldBlock>
      )
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label="Tag">
          <TagSelect
            value={(cfg.tag_id as string) ?? ""}
            onChange={(v) => set({ tag_id: v })}
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label="Mode">
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="round_robin">Round-robin</option>
              <option value="specific">Specific agent</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label="Agent">
              <AgentSelect
                value={(cfg.agent_id as string) ?? ""}
                onChange={(v) => set({ agent_id: v })}
              />
            </FieldBlock>
          )}
        </>
      )
    case "update_contact_field":
      return (
        <>
          <FieldBlock label="Field">
            <ContactFieldSelect
              value={(cfg.field as string) ?? "name"}
              onChange={(v) => set({ field: v })}
            />
          </FieldBlock>
          <FieldBlock label="Value">
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              placeholder="Text or {{ vars.x }} / {{ message.text }}"
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "create_deal":
      return (
        <>
          <DealPipelineFields
            pipelineId={(cfg.pipeline_id as string) ?? ""}
            stageId={(cfg.stage_id as string) ?? ""}
            onChange={(patch) => set(patch)}
          />
          <FieldBlock label="Title">
            <Input
              value={(cfg.title as string) ?? ""}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label="Value">
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label="Amount">
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label="Unit">
            <select
              value={(cfg.unit as string) ?? "hours"}
              onChange={(e) => set({ unit: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </select>
          </FieldBlock>
        </div>
      )
    case "condition":
      return (
        <>
          <FieldBlock label="Subject">
            <select
              value={(cfg.subject as string) ?? "tag_presence"}
              onChange={(e) => set({ subject: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="tag_presence">Tag presence</option>
              <option value="contact_field">Contact field</option>
              <option value="message_content">Message content</option>
              <option value="time_of_day">Time of day</option>
            </select>
          </FieldBlock>
          <FieldBlock label="Operand">
            <Input
              placeholder={
                cfg.subject === "time_of_day"
                  ? "HH:mm-HH:mm"
                  : cfg.subject === "contact_field"
                  ? "name / email / company"
                  : cfg.subject === "tag_presence"
                  ? "tag id"
                  : ""
              }
              value={(cfg.operand as string) ?? ""}
              onChange={(e) => set({ operand: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          {(cfg.subject === "contact_field" || cfg.subject === "message_content") && (
            <FieldBlock label="Value">
              <Input
                value={(cfg.value as string) ?? ""}
                onChange={(e) => set({ value: e.target.value })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          )}
        </>
      )
    case "send_webhook":
      return (
        <>
          <FieldBlock label="URL">
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label="Body template (JSON)">
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              className="min-h-20 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-muted-foreground">
          Sets the conversation status to &quot;closed&quot;. No configuration needed.
        </p>
      )
    default:
      return null
  }
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function previewFor(step: BuilderStep): string {
  switch (step.step_type) {
    case "send_message":
      return (step.step_config.text as string) || "no text yet"
    case "send_template":
      return (step.step_config.template_name as string) || "pick a template"
    case "wait":
      return `${step.step_config.amount ?? "?"} ${step.step_config.unit ?? ""}`
    case "condition":
      return `when ${step.step_config.subject ?? "?"}`
    case "send_webhook":
      return (step.step_config.url as string) || "no url"
    default:
      return ""
  }
}

// ------------------------------------------------------------
// Tree mutation helpers
// ------------------------------------------------------------

function insertAt(
  steps: BuilderStep[],
  parent: ParentScope,
  index: number,
  node: BuilderStep,
): BuilderStep[] {
  if (parent.kind === "root") {
    const copy = [...steps]
    copy.splice(index, 0, node)
    return copy
  }
  return steps.map((s) => {
    if (s.cid !== parent.parentCid || !s.branches) return s
    const list = [...s.branches[parent.branch]]
    list.splice(index, 0, node)
    return { ...s, branches: { ...s.branches, [parent.branch]: list } }
  })
}

function mapAtPath(
  steps: BuilderStep[],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)

  if (head.kind === "root") {
    return steps.map((s, i) => {
      if (i !== head.index) return s
      return rest.length === 0
        ? updater(s)
        : { ...s, branches: walkBranches(s.branches, rest, updater) }
    })
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const updated = bucket.map((child, i) => {
      if (i !== head.index) return child
      return rest.length === 0
        ? updater(child)
        : { ...child, branches: walkBranches(child.branches, rest, updater) }
    })
    return { ...s, branches: { ...s.branches, [head.branch]: updated } }
  })
}

function walkBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const bucket = branches[head.branch]
  const rest = path.slice(1)
  const updated = bucket.map((child, i) => {
    if (i !== head.index) return child
    return rest.length === 0
      ? updater(child)
      : { ...child, branches: walkBranches(child.branches, rest, updater) }
  })
  return { ...branches, [head.branch]: updated }
}

function removeAt(steps: BuilderStep[], path: StepPath): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  if (head.kind === "root") {
    if (rest.length === 0) return steps.filter((_, i) => i !== head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: removeFromBranches(s.branches, rest) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next =
      rest.length === 0
        ? bucket.filter((_, i) => i !== head.index)
        : bucket.map((child, i) =>
            i !== head.index
              ? child
              : { ...child, branches: removeFromBranches(child.branches, rest) },
          )
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function removeFromBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const next =
    rest.length === 0
      ? bucket.filter((_, i) => i !== head.index)
      : bucket.map((child, i) =>
          i !== head.index
            ? child
            : { ...child, branches: removeFromBranches(child.branches, rest) },
        )
  return { ...branches, [head.branch]: next }
}

function moveAt(
  steps: BuilderStep[],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  if (head.kind === "root") {
    if (rest.length === 0) return swap(steps, head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: moveInBranches(s.branches, rest, direction) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next = rest.length === 0 ? swap(bucket, head.index) : bucket
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function moveInBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  const next = rest.length === 0 ? swap(bucket, head.index) : bucket
  return { ...branches, [head.branch]: next }
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: ApiStep[]; no?: ApiStep[] }
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }))
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] }
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: cid(),
    step_type: n.step_type as AutomationStepType,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === "condition"
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }))
}
