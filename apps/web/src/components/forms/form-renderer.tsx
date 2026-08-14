'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, AlertCircle, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { SlotPicker } from './slot-picker';

// -----------------------------------------------------------------------
// SHARED — no dashboard-only imports (no useAuth, no Supabase client).
// This component is used by:
//   1. The hosted form page  (/f/[slug])
//   2. Embedded snippets     (via iframe on customer sites)
//   3. The widget pre-chat   (widget-prechat.tsx wraps this)
//   4. The builder preview   (FormBuilderPage tab)
// -----------------------------------------------------------------------

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'time'
  | 'file'
  | 'rating'
  | 'hidden'
  | 'consent'
  | 'heading'
  | 'paragraph'
  | 'appointment_slot';

export interface PublicFormField {
  field_key: string;
  type: FormFieldType;
  label: string;
  placeholder?: string;
  help_text?: string;
  required?: boolean;
  width?: 'full' | 'half';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  scale?: number;
  accept?: string[];
}

export interface PublicForm {
  id: string;
  name: string;
  description?: string | null;
  slug: string;
  kind: 'form' | 'booking';
  fields: PublicFormField[];
  settings: {
    submit_label: string;
    honeypot: boolean;
  };
}

export type SlotFetcher = (range: { from: string; to: string }) => Promise<{
  timezone: string;
  days: Array<{
    date: string;
    slots: Array<{ start: string; end: string; remaining: number }>;
  }>;
}>;

export interface FormSubmitResult {
  successMode: string;
  successMessage: string;
  redirectUrl: string | null;
}

export interface FormSubmitPayload {
  answers: Record<string, unknown>;
  spam: { elapsedMs: number };
}

interface FormRendererProps {
  form: PublicForm;
  source?: 'hosted' | 'embed';
  slug?: string;
  /**
   * Where the answers go.
   *
   * WHY THIS IS A PROP AND NOT A BAKED-IN FETCH
   *   This renderer serves three trust contexts: a hosted page (anonymous),
   *   the dashboard preview (must not submit at all), and the widget (has a
   *   signed visitor session). They post to different endpoints on purpose
   *   — `POST /public/forms/:slug/submit` deliberately refuses to accept a
   *   contact or conversation id because it is unauthenticated, so a widget
   *   submission that needs to land in a live thread has to go through
   *   `POST /public/web/forms/:id/submit`, where the session token proves
   *   which conversation is the caller's.
   *
   *   Making the caller supply the submit keeps that boundary visible at
   *   each call site instead of hidden behind a `source` string that the
   *   server would then have to distrust anyway.
   *
   *   Omitted = post to the hosted endpoint.
   */
  onSubmit?: (payload: FormSubmitPayload) => Promise<FormSubmitResult>;
  onSuccess?: (result: FormSubmitResult) => void;
  /** Preview mode: disable actual submission */
  preview?: boolean;
  /** Tighter spacing + smaller type, for rendering inside the widget panel. */
  compact?: boolean;
  /**
   * How to load bookable times for an `appointment_slot` field.
   *
   * A prop rather than a baked-in fetch because the three contexts query
   * different endpoints — a slug on the hosted page, a manage token when
   * rescheduling — and the dashboard preview has no live availability at all,
   * where omitting it is what makes the field say so instead of rendering an
   * empty grid.
   */
  fetchSlots?: SlotFetcher;
}

export default function FormRenderer({
  form,
  source = 'hosted',
  slug,
  onSubmit,
  onSuccess,
  preview = false,
  compact = false,
  fetchSlots,
}: FormRendererProps) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [startTime] = useState(Date.now());

  // Initialise hidden defaults
  const initialAnswers: Record<string, unknown> = {};
  form.fields.forEach((f) => {
    if (f.type === 'hidden' && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      initialAnswers[f.field_key] = params.get(f.field_key) ?? '';
    }
  });

  const setAnswer = (key: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    form.fields.forEach((f) => {
      if (f.type === 'heading' || f.type === 'paragraph' || f.type === 'hidden') return;
      if (!f.required) return;
      const val = answers[f.field_key];
      const empty =
        val === undefined ||
        val === null ||
        val === '' ||
        (Array.isArray(val) && val.length === 0);
      if (empty) errs[f.field_key] = `${f.label} is required`;
    });
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (preview) {
      toast.info('Preview mode — submission disabled');
      return;
    }
    if (!validate()) return;

    setSubmitting(true);
    try {
      const payload: FormSubmitPayload = {
        answers: { ...initialAnswers, ...answers },
        spam: { elapsedMs: Date.now() - startTime },
      };

      const result = onSubmit
        ? await onSubmit(payload)
        : await postToHostedEndpoint(slug ?? form.slug, source, payload, setErrors);

      // A field-level rejection has already been painted onto the inputs by
      // whichever submit ran; there is nothing to celebrate and nothing to
      // report as an error.
      if (!result) return;

      if (result.successMode === 'redirect' && result.redirectUrl) {
        window.location.href = result.redirectUrl;
        return;
      }

      setSuccessMessage(result.successMessage ?? 'Thanks! We received your submission.');
      setSubmitted(true);
      onSuccess?.(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit form');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 text-accent-green">
          <CheckCircle2 className="h-10 w-10" />
        </div>
        <p className="text-xl font-semibold text-foreground">
          {successMessage || 'Thanks — we got your submission!'}
        </p>
      </div>
    );
  }

  const visibleFields = form.fields.filter((f) => f.type !== 'hidden');

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap gap-6">
      {visibleFields.map((field) => (
        <FieldInput
          key={field.field_key}
          field={field}
          value={answers[field.field_key]}
          error={errors[field.field_key]}
          onChange={(val) => setAnswer(field.field_key, val)}
          fetchSlots={fetchSlots}
        />
      ))}

      {/* Honeypot */}
      {form.settings.honeypot && (
        <input
          name="_hp"
          tabIndex={-1}
          autoComplete="off"
          style={{ display: 'none' }}
          aria-hidden
          onChange={(e) => setAnswer('__honeypot', e.target.value)}
        />
      )}

      <div className="w-full pt-2">
        <Button
          type="submit"
          id="btn-submit-form"
          disabled={submitting}
          className="w-full sm:w-auto px-8 py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white font-medium shadow-md shadow-violet-500/20 rounded-lg transition-all"
        >
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {form.settings.submit_label || 'Submit'}
        </Button>
      </div>
    </form>
  );
}

// -----------------------------------------------------------------------
// Per-field input renderer
// -----------------------------------------------------------------------

interface FieldInputProps {
  /** Supplied only where live availability can be queried. */
  fetchSlots?: SlotFetcher;
  field: PublicFormField;
  value: unknown;
  error: string | undefined;
  onChange: (value: unknown) => void;
}

function FieldInput({
  field,
  value,
  error,
  onChange,
  fetchSlots,
}: FieldInputProps) {
  const strVal = (value as string) ?? '';

  // Presentational fields
  if (field.type === 'heading') {
    return (
      <div className="w-full pt-2">
        <h2 className="text-xl font-bold tracking-tight text-foreground">
          {field.label}
        </h2>
        {field.help_text && (
          <p className="mt-1 text-xs text-muted-foreground">{field.help_text}</p>
        )}
      </div>
    );
  }

  if (field.type === 'paragraph') {
    return (
      <div className="w-full">
        <p className="text-sm leading-relaxed text-muted-foreground">{field.label}</p>
      </div>
    );
  }

  const labelEl = (
    <Label
      htmlFor={`field-${field.field_key}`}
      className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
    >
      {field.label}
      {field.required && <span className="text-destructive font-bold">*</span>}
    </Label>
  );

  const helpEl = field.help_text && (
    <p className="text-xs text-muted-foreground/80">{field.help_text}</p>
  );

  const errorEl = error && (
    <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
      <AlertCircle className="h-3.5 w-3.5" />
      {error}
    </p>
  );

  let inputEl: React.ReactNode = null;

  switch (field.type) {
    case 'text':
    case 'email':
    case 'phone':
    case 'number':
      inputEl = (
        <Input
          id={`field-${field.field_key}`}
          type={field.type === 'phone' ? 'tel' : field.type}
          placeholder={field.placeholder}
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'h-10 bg-background text-foreground border-input placeholder:text-muted-foreground/50 rounded-lg transition-all focus-visible:ring-2 focus-visible:ring-violet-500/20 focus-visible:border-violet-500',
            error && 'border-destructive focus-visible:ring-destructive/20',
          )}
        />
      );
      break;

    case 'textarea':
      inputEl = (
        <Textarea
          id={`field-${field.field_key}`}
          placeholder={field.placeholder}
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={cn(
            'bg-background text-foreground border-input placeholder:text-muted-foreground/50 rounded-lg transition-all focus-visible:ring-2 focus-visible:ring-violet-500/20 focus-visible:border-violet-500',
            error && 'border-destructive focus-visible:ring-destructive/20',
          )}
        />
      );
      break;

    case 'select':
      inputEl = (
        <select
          id={`field-${field.field_key}`}
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs transition-all focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500',
            error && 'border-destructive focus:ring-destructive/20',
          )}
        >
          <option value="" className="bg-background text-foreground">
            {field.placeholder || 'Choose an option…'}
          </option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value} className="bg-background text-foreground py-1">
              {o.label}
            </option>
          ))}
        </select>
      );
      break;

    case 'radio':
      inputEl = (
        <div className="flex flex-col gap-2 pt-1">
          {field.options?.map((o) => {
            const isSelected = strVal === o.value;
            return (
              <label
                key={o.value}
                className={cn(
                  'flex items-center gap-3 rounded-lg border border-input bg-background/50 px-3.5 py-2.5 text-sm text-foreground cursor-pointer transition-all hover:bg-muted/40',
                  isSelected && 'border-violet-500 bg-violet-500/10 font-medium text-foreground',
                )}
              >
                <input
                  type="radio"
                  name={field.field_key}
                  value={o.value}
                  checked={isSelected}
                  onChange={() => onChange(o.value)}
                  className="h-4 w-4 accent-violet-600 text-accent-violet focus:ring-violet-500"
                />
                <span className="flex-1 text-foreground">{o.label}</span>
              </label>
            );
          })}
        </div>
      );
      break;

    case 'multiselect':
    case 'checkbox': {
      const checked = Array.isArray(value) ? (value as string[]) : [];
      inputEl = (
        <div className="flex flex-col gap-2 pt-1">
          {field.options?.map((o) => {
            const isChecked = checked.includes(o.value);
            return (
              <label
                key={o.value}
                className={cn(
                  'flex items-center gap-3 rounded-lg border border-input bg-background/50 px-3.5 py-2.5 text-sm text-foreground cursor-pointer transition-all hover:bg-muted/40',
                  isChecked && 'border-violet-500 bg-violet-500/10 font-medium text-foreground',
                )}
              >
                <input
                  type="checkbox"
                  value={o.value}
                  checked={isChecked}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...checked, o.value]
                      : checked.filter((v) => v !== o.value);
                    onChange(next);
                  }}
                  className="h-4 w-4 rounded-sm accent-violet-600 text-accent-violet focus:ring-violet-500"
                />
                <span className="flex-1 text-foreground">{o.label}</span>
              </label>
            );
          })}
        </div>
      );
      break;
    }

    case 'date':
      inputEl = (
        <Input
          id={`field-${field.field_key}`}
          type="date"
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'h-10 bg-background text-foreground border-input rounded-lg transition-all focus-visible:ring-2 focus-visible:ring-violet-500/20 focus-visible:border-violet-500',
            error && 'border-destructive',
          )}
        />
      );
      break;

    case 'time':
      inputEl = (
        <Input
          id={`field-${field.field_key}`}
          type="time"
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'h-10 bg-background text-foreground border-input rounded-lg transition-all focus-visible:ring-2 focus-visible:ring-violet-500/20 focus-visible:border-violet-500',
            error && 'border-destructive',
          )}
        />
      );
      break;

    case 'rating': {
      const scale = field.scale ?? 5;
      const numVal = typeof value === 'number' ? value : 0;
      inputEl = (
        <div className="flex gap-1.5 pt-1">
          {Array.from({ length: scale }, (_, i) => i + 1).map((star) => {
            const active = numVal >= star;
            return (
              <button
                key={star}
                type="button"
                onClick={() => onChange(star)}
                className="p-1 transition-transform hover:scale-110 focus:outline-none"
                aria-label={`${star} star${star !== 1 ? 's' : ''}`}
              >
                <Star
                  className={cn(
                    'h-7 w-7 transition-colors',
                    active
                      ? 'fill-accent-amber text-accent-amber'
                      : 'fill-muted/40 text-muted-foreground/40 hover:text-accent-amber',
                  )}
                />
              </button>
            );
          })}
        </div>
      );
      break;
    }

    case 'consent':
      inputEl = (
        <label className="flex items-start gap-3 rounded-lg border border-input bg-background/50 p-3.5 text-sm text-foreground cursor-pointer transition-all hover:bg-muted/40">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded-sm accent-violet-600 text-accent-violet focus:ring-violet-500"
          />
          <span className={cn('flex-1 text-sm text-foreground leading-snug', error && 'text-destructive font-medium')}>
            {field.label}
          </span>
        </label>
      );
      return (
        <div className="w-full flex flex-col gap-1.5">
          {inputEl}
          {helpEl}
          {errorEl}
        </div>
      );

    case 'file':
      inputEl = (
        <Input
          id={`field-${field.field_key}`}
          type="file"
          accept={field.accept?.join(',')}
          onChange={(e) => onChange(e.target.files?.[0] ?? null)}
          className={cn(
            'h-10 bg-background text-foreground border-input rounded-lg file:mr-4 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-violet-500/10 file:text-accent-violet hover:file:bg-violet-500/20 cursor-pointer',
            error && 'border-destructive',
          )}
        />
      );
      break;

    case 'appointment_slot':
      inputEl = fetchSlots ? (
        <SlotPicker
          fetchSlots={fetchSlots}
          value={typeof value === 'string' ? value : null}
          onChange={(iso) => onChange(iso)}
        />
      ) : (
        // No loader supplied — the dashboard preview, where there is no live
        // availability to query. Says so rather than rendering an empty grid
        // that reads as "no times available".
        <div className="rounded-lg border border-input bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          Times appear here once this form is published.
        </div>
      );
      break;

    default:
      return null;
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2',
        field.width === 'half' ? 'w-full sm:w-[calc(50%-0.75rem)]' : 'w-full',
      )}
    >
      {labelEl}
      {inputEl}
      {helpEl}
      {errorEl}
    </div>
  );
}

/**
 * The default submit: the unauthenticated hosted endpoint.
 *
 * Returns null when the server rejected individual fields — those are
 * painted onto the inputs and are not an error worth a toast. Anything else
 * throws, so the caller's catch surfaces it.
 */
async function postToHostedEndpoint(
  target: string,
  source: 'hosted' | 'embed',
  payload: FormSubmitPayload,
  setErrors: (errors: Record<string, string>) => void,
): Promise<FormSubmitResult | null> {
  const res = await fetch(`/api/public/forms/${target}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      source,
      meta: {
        pageUrl: typeof window !== 'undefined' ? window.location.href : '',
        referrer: typeof document !== 'undefined' ? document.referrer : '',
      },
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      errors?: Array<{ field_key: string; message: string }>;
      issues?: Array<{ field_key: string; message: string }>;
      message?: string;
    };
    // The server calls them `errors`; an older shape called them `issues`.
    // Accept both so a version skew between app and API degrades to
    // "highlighted fields" rather than a generic failure toast.
    const fieldErrors = body.errors ?? body.issues;
    if (fieldErrors?.length) {
      const errs: Record<string, string> = {};
      for (const item of fieldErrors) errs[item.field_key] = item.message;
      setErrors(errs);
      return null;
    }
    throw new Error(body.message ?? 'Submission failed');
  }

  return (await res.json()) as FormSubmitResult;
}
