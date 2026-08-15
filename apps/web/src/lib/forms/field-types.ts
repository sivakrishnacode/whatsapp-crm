/**
 * The field-type catalogue the builder is drawn from.
 *
 * ONE ENTRY PER TYPE, AND THE ENTRY DECIDES THE UI
 *   Which inspector controls appear is derived from the flags here rather
 *   than from `if (type === …)` chains scattered through the panel. Adding
 *   a type is one row plus, if it needs one, one renderer case — and it
 *   cannot render with settings it does not support.
 *
 * ⚠️ `type` must stay in step with FORM_FIELD_TYPES in
 * apps/api/src/forms/form.types.ts. A type offered here and unknown there
 * is refused at save time with "Unknown field type", after the person has
 * already built the form.
 */

import {
  AlignCenter,
  AlignLeft,
  CalendarClock,
  Calendar,
  CheckSquare,
  ChevronDown,
  Circle,
  Clock,
  EyeOff,
  Hash,
  Heading1,
  Mail,
  Paperclip,
  Phone,
  SeparatorHorizontal,
  SquareCheck,
  Star,
  ToggleLeft,
  Type,
} from 'lucide-react';

import type {
  FormFieldType,
  PublicFormField,
} from '@/components/forms/form-renderer';

/**
 * A field as the BUILDER sees it.
 *
 * The renderer's `PublicFormField` is the visitor's view, and the server
 * strips `mapping` and `default_value` from it on purpose — they describe
 * the tenant's own CRM structure and are none of a visitor's business
 * (`toPublicProjection` in forms.service.ts). The dashboard is the one
 * place both exist, so it gets its own superset rather than widening the
 * public type and quietly making the strip look unnecessary.
 */
export interface FormBuilderField extends PublicFormField {
  /** `name` | `email` | `phone` | `company` | `custom:<custom_field_id>`. */
  mapping?: string;
  /** hidden only — used when the URL carries no matching query param. */
  default_value?: string;
}

export interface FieldTypeDef {
  type: FormFieldType;
  label: string;
  /** One line in the palette tooltip — what it is FOR, not what it is. */
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  group: FieldGroup;
  /** Carries no answer, so it is never a condition source and never required. */
  presentational?: boolean;
  /** Offers a list of options. */
  choice?: boolean;
  /** Accepts a placeholder. */
  placeholder?: boolean;
  /** Accepts numeric bounds. */
  bounds?: boolean;
  /** Can be mapped onto a contact column or custom field. */
  mappable?: boolean;
}

export type FieldGroup =
  | 'Input'
  | 'Choice'
  | 'Date & time'
  | 'Special'
  | 'Layout';

export const FIELD_GROUP_ORDER: FieldGroup[] = [
  'Input',
  'Choice',
  'Date & time',
  'Special',
  'Layout',
];

export const FIELD_TYPES: FieldTypeDef[] = [
  {
    type: 'text',
    label: 'Short text',
    hint: 'A single line — names, job titles, reference numbers.',
    icon: Type,
    group: 'Input',
    placeholder: true,
    mappable: true,
  },
  {
    type: 'textarea',
    label: 'Long text',
    hint: 'A paragraph. Use for "how can we help?".',
    icon: AlignLeft,
    group: 'Input',
    placeholder: true,
  },
  {
    type: 'email',
    label: 'Email',
    hint: 'Validated, and the usual way a submission finds an existing contact.',
    icon: Mail,
    group: 'Input',
    placeholder: true,
    mappable: true,
  },
  {
    type: 'phone',
    label: 'Phone',
    hint: 'Validated loosely, then normalised. Needed to reply on WhatsApp.',
    icon: Phone,
    group: 'Input',
    placeholder: true,
    mappable: true,
  },
  {
    type: 'number',
    label: 'Number',
    hint: 'Digits only, with optional minimum and maximum.',
    icon: Hash,
    group: 'Input',
    placeholder: true,
    bounds: true,
    mappable: true,
  },

  {
    type: 'select',
    label: 'Dropdown',
    hint: 'One answer from a long list, without taking up the room.',
    icon: ChevronDown,
    group: 'Choice',
    choice: true,
    placeholder: true,
    mappable: true,
  },
  {
    type: 'radio',
    label: 'Radio buttons',
    hint: 'One answer from a few, all visible at once.',
    icon: Circle,
    group: 'Choice',
    choice: true,
    mappable: true,
  },
  {
    type: 'multiselect',
    label: 'Checkbox list',
    hint: 'Any number of answers from a list.',
    icon: CheckSquare,
    group: 'Choice',
    choice: true,
  },
  {
    type: 'checkbox',
    label: 'Checkboxes',
    hint: 'A tick list. Stored as the boxes that were ticked.',
    icon: SquareCheck,
    group: 'Choice',
    choice: true,
  },

  {
    type: 'date',
    label: 'Date',
    hint: 'A calendar picker.',
    icon: Calendar,
    group: 'Date & time',
    mappable: true,
  },
  {
    type: 'time',
    label: 'Time',
    hint: 'A time of day, unconnected to your availability.',
    icon: Clock,
    group: 'Date & time',
  },
  {
    type: 'appointment_slot',
    label: 'Appointment slot',
    hint: 'Bookable times from your availability. Adding this makes it a booking form.',
    icon: CalendarClock,
    group: 'Date & time',
  },

  {
    type: 'rating',
    label: 'Rating',
    hint: 'Stars, for feedback and CSAT.',
    icon: Star,
    group: 'Special',
  },
  {
    type: 'consent',
    label: 'Consent',
    hint: 'A tick box that must be ticked. Use for marketing opt-in.',
    icon: ToggleLeft,
    group: 'Special',
  },
  {
    type: 'file',
    label: 'File upload',
    hint: 'One file — briefs, CVs, photos of a fault.',
    icon: Paperclip,
    group: 'Special',
  },
  {
    type: 'hidden',
    label: 'Hidden field',
    hint: 'Not shown. Filled from a URL query parameter, for campaign tracking.',
    icon: EyeOff,
    group: 'Special',
    mappable: true,
  },

  {
    type: 'heading',
    label: 'Heading',
    hint: 'A section title.',
    icon: Heading1,
    group: 'Layout',
    presentational: true,
  },
  {
    type: 'paragraph',
    label: 'Paragraph',
    hint: 'Explanatory text between questions.',
    icon: AlignCenter,
    group: 'Layout',
    presentational: true,
  },
  {
    type: 'page_break',
    label: 'Page break',
    hint: 'Splits the form into steps, with a progress bar.',
    icon: SeparatorHorizontal,
    group: 'Layout',
    presentational: true,
  },
];

export const FIELD_TYPE_MAP: Record<string, FieldTypeDef> = Object.fromEntries(
  FIELD_TYPES.map((f) => [f.type, f]),
);

export function fieldTypeDef(type: string): FieldTypeDef | undefined {
  return FIELD_TYPE_MAP[type];
}

/**
 * Mint a field key.
 *
 * Derived from the label so a submissions export has readable columns,
 * but suffixed and uniqued because the key is what `submissions.data` is
 * keyed by and must survive the label being reworded. Generated ONCE, on
 * creation — never regenerated, or every historical submission loses the
 * column it belonged to.
 */
export function makeFieldKey(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'field';

  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}
