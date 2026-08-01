import type { MessageTemplate, TemplateParameterFormat } from '@/types'
import { variableTokens } from './template-form'
import type {
  SendTimeParams,
  TemplateLocationParam,
} from './template-send-builder'

/**
 * Everything a template needs supplied at send time.
 *
 * ## Why this is one shared module
 *
 * A template is only sendable if every parameter Meta expects is
 * present, and Meta rejects the whole send when one is missing —
 * "Location header requires latitude and longitude at send time" for a
 * LOCATION header, "number of parameters does not match" for a body
 * variable. Each send surface (inbox composer, contact detail,
 * automations, broadcasts) was deciding for itself which inputs to
 * show, so each supported a different subset and a template that sent
 * fine from one silently failed from another.
 *
 * Deriving the required slots in one place means a surface can only be
 * wrong by not rendering what it is handed — and it can check
 * `missingSlots()` to refuse rather than send something it knows Meta
 * will reject.
 *
 * `header_type` is compared case-insensitively on purpose: the column
 * holds lowercase ('image', 'location') while Meta's own vocabulary and
 * the API-side snapshot use uppercase.
 */

export interface UrlButtonSlot {
  index: number
  text: string
  url: string
  /** The `{{n}}`/`{{name}}` token inside the URL, minus the braces. */
  token: string
}

export interface CopyCodeButtonSlot {
  index: number
  text: string
}

export type HeaderMediaKind = 'IMAGE' | 'VIDEO' | 'DOCUMENT'

export interface TemplateSlots {
  format: TemplateParameterFormat
  /** Tokens in the body, in the order their values must be supplied. */
  bodyVars: string[]
  /** Tokens in a TEXT header. Meta allows at most one, but read them all. */
  headerTextVars: string[]
  /**
   * Set for IMAGE/VIDEO/DOCUMENT headers. `hasDefault` is true when the
   * template row already carries a media URL — then the send works
   * without asking, and the input is an optional override.
   */
  headerMedia: { kind: HeaderMediaKind; hasDefault: boolean } | null
  /**
   * True for a LOCATION header. There is no template-level default and
   * never can be: the pin is per send. This is the slot whose absence
   * produced "Location header requires latitude and longitude".
   */
  headerLocation: boolean
  urlButtons: UrlButtonSlot[]
  copyCodeButtons: CopyCodeButtonSlot[]
}

/** Mutable form state matching the slots. */
export interface TemplateSlotValues {
  body: string[]
  headerText: string
  headerMediaUrl: string
  headerLocation: { latitude: string; longitude: string; name: string; address: string }
  buttonParams: Record<number, string>
}

export function emptySlotValues(slots: TemplateSlots): TemplateSlotValues {
  return {
    body: new Array(slots.bodyVars.length).fill(''),
    headerText: '',
    headerMediaUrl: '',
    headerLocation: { latitude: '', longitude: '', name: '', address: '' },
    buttonParams: {},
  }
}

function headerKind(template: MessageTemplate): string {
  return (template.header_type ?? '').toString().toUpperCase()
}

export function collectTemplateSlots(template: MessageTemplate): TemplateSlots {
  const format: TemplateParameterFormat =
    template.parameter_format === 'NAMED' ? 'NAMED' : 'POSITIONAL'
  const kind = headerKind(template)

  const urlButtons: UrlButtonSlot[] = []
  const copyCodeButtons: CopyCodeButtonSlot[] = []
  ;(template.buttons ?? []).forEach((button, index) => {
    if (button.type === 'URL') {
      // Only a URL containing a variable needs a value; a fully static
      // URL button is sent as approved and asking for one would be
      // noise the sender cannot answer.
      const token = variableTokens(button.url ?? '', format)[0]
      if (token) {
        urlButtons.push({ index, text: button.text, url: button.url ?? '', token })
      }
      return
    }
    if (button.type === 'COPY_CODE') {
      // Meta requires the coupon code at send time even though the
      // button text is fixed.
      copyCodeButtons.push({ index, text: button.text })
    }
  })

  return {
    format,
    bodyVars: variableTokens(template.body_text ?? '', format),
    headerTextVars:
      kind === 'TEXT' && template.header_content
        ? variableTokens(template.header_content, format)
        : [],
    headerMedia:
      kind === 'IMAGE' || kind === 'VIDEO' || kind === 'DOCUMENT'
        ? { kind, hasDefault: Boolean(template.header_media_url) }
        : null,
    headerLocation: kind === 'LOCATION',
    urlButtons,
    copyCodeButtons,
  }
}

/** True when the template can be sent without asking for anything. */
export function slotsAreEmpty(slots: TemplateSlots): boolean {
  return (
    slots.bodyVars.length === 0 &&
    slots.headerTextVars.length === 0 &&
    slots.headerLocation === false &&
    (slots.headerMedia === null || slots.headerMedia.hasDefault) &&
    slots.urlButtons.length === 0 &&
    slots.copyCodeButtons.length === 0
  )
}

/**
 * Human-readable list of what is still unfilled, for disabling a send
 * button and saying why.
 *
 * Meta rejects the entire send on any missing parameter, so "partially
 * filled" is not a state worth allowing through — better to name the
 * gap here than to surface Meta's error after the fact.
 */
export function missingSlots(
  slots: TemplateSlots,
  values: TemplateSlotValues,
): string[] {
  const missing: string[] = []
  const blank = (s: string | undefined) => !(s ?? '').trim()

  slots.bodyVars.forEach((token, i) => {
    if (blank(values.body[i])) missing.push(`Body {{${token}}}`)
  })

  if (slots.headerTextVars.length > 0 && blank(values.headerText)) {
    missing.push('Header text')
  }

  if (slots.headerMedia && !slots.headerMedia.hasDefault) {
    if (blank(values.headerMediaUrl)) {
      missing.push(`${titleCase(slots.headerMedia.kind)} header URL`)
    }
  }

  if (slots.headerLocation) {
    // All four, not just the coordinates. Verified against the live
    // API: Meta answers a missing `name` with "Parameter 'name' is
    // mandatory for component parameter type 'location'", and the same
    // for `address`. The location *message* object documents both as
    // optional, which is the source of the confusion.
    const labels: Record<string, string> = {
      latitude: 'latitude',
      longitude: 'longitude',
      name: 'place name',
      address: 'address',
    }
    const absent = (['latitude', 'longitude', 'name', 'address'] as const)
      .filter((field) => blank(values.headerLocation[field]))
      .map((field) => labels[field])
    if (absent.length > 0) {
      missing.push(`Header location (${absent.join(', ')})`)
    }
  }

  slots.urlButtons.forEach((slot) => {
    if (blank(values.buttonParams[slot.index])) {
      missing.push(`URL button "${slot.text}"`)
    }
  })

  slots.copyCodeButtons.forEach((slot) => {
    if (blank(values.buttonParams[slot.index])) {
      missing.push(`Coupon code for "${slot.text}"`)
    }
  })

  return missing
}

function titleCase(kind: HeaderMediaKind): string {
  return kind.charAt(0) + kind.slice(1).toLowerCase()
}

/**
 * Turn the form state into the `SendTimeParams` the send builder wants.
 *
 * Only the fields the template actually uses are emitted. An empty
 * `headerLocation` or `headerMediaUrl` would otherwise be sent as a
 * present-but-blank parameter, which Meta rejects more confusingly than
 * an absent one.
 */
export function buildSendParams(
  slots: TemplateSlots,
  values: TemplateSlotValues,
): SendTimeParams {
  const params: SendTimeParams = { body: values.body.map((v) => v.trim()) }

  if (slots.headerTextVars.length > 0 && values.headerText.trim()) {
    params.headerText = values.headerText.trim()
  }

  if (slots.headerMedia && values.headerMediaUrl.trim()) {
    params.headerMediaUrl = values.headerMediaUrl.trim()
  }

  if (slots.headerLocation) {
    const loc = values.headerLocation
    // Emitted whole or not at all — a partial pin is a rejected send,
    // and all four fields are mandatory (see missingSlots).
    if (
      loc.latitude.trim() &&
      loc.longitude.trim() &&
      loc.name.trim() &&
      loc.address.trim()
    ) {
      params.headerLocation = {
        latitude: loc.latitude.trim(),
        longitude: loc.longitude.trim(),
        name: loc.name.trim(),
        address: loc.address.trim(),
      }
    }
  }

  const buttonEntries = Object.entries(values.buttonParams)
    .filter(([, v]) => (v ?? '').trim())
    .map(([k, v]) => [Number(k), v.trim()] as const)
  if (buttonEntries.length > 0) {
    params.buttonParams = Object.fromEntries(buttonEntries)
  }

  return params
}
