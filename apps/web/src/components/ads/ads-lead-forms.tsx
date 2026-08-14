'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, FileText, Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { useCan } from '@/hooks/use-can';
import { formatCount, type MetaLeadFormSummary } from '@/lib/ads/types';

/**
 * The question types the API exposes, and which of them this CRM can
 * actually store.
 *
 * PHONE is marked required because the Facebook leads webhook DROPS a lead
 * with no usable phone number — `contacts` requires a phone, an IGSID or a
 * web visitor id, and a lead-form submission has none of the other two. A
 * form without it produces submissions that silently vanish, so the UI
 * makes it non-optional and the API adds it back if it is somehow missing.
 */
const QUESTION_TYPES = [
  { value: 'PHONE', label: 'Phone number', required: true },
  { value: 'FULL_NAME', label: 'Full name' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'CITY', label: 'City' },
  { value: 'COMPANY_NAME', label: 'Company' },
  { value: 'JOB_TITLE', label: 'Job title' },
] as const;

export function AdsLeadForms() {
  const canEdit = useCan('edit-settings');
  const [forms, setForms] = useState<MetaLeadFormSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState('');
  const [selected, setSelected] = useState<string[]>(['PHONE', 'FULL_NAME']);
  const [thankYouTitle, setThankYouTitle] = useState('');
  const [thankYouBody, setThankYouBody] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ads/lead-forms', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? 'Request failed');
      }
      const json = (await res.json()) as { data: MetaLeadFormSummary[] };
      setForms(json.data);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not load lead forms.',
      );
      setForms([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch('/api/ads/lead-forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          privacyPolicyUrl,
          questions: selected.map((type) => ({ type })),
          thankYouTitle: thankYouTitle || undefined,
          thankYouBody: thankYouBody || undefined,
        }),
      });

      const body = (await res.json().catch(() => null)) as {
        message?: string | string[];
        addedPhoneQuestion?: boolean;
      } | null;

      if (!res.ok) {
        const message = Array.isArray(body?.message)
          ? body.message.join(', ')
          : body?.message;
        throw new Error(message ?? 'Meta rejected the form.');
      }

      if (body?.addedPhoneQuestion) {
        toast.success(
          'Form created. A phone-number question was added — without one, leads cannot be saved as contacts.',
        );
      } else {
        toast.success('Lead form created.');
      }

      setCreating(false);
      setName('');
      setPrivacyPolicyUrl('');
      setSelected(['PHONE', 'FULL_NAME']);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Lead forms
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Meta <strong>instant forms</strong> — the ones Facebook renders
            inside a Lead Form ad, with no website involved. Not the same as
            your{' '}
            <Link href="/forms" className="underline">
              hosted web forms
            </Link>
            . Submissions arrive automatically as contacts and pipeline deals.
          </p>
        </div>
        {canEdit ? (
          <Button size="sm" onClick={() => setCreating((v) => !v)}>
            {creating ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
            {creating ? 'Cancel' : 'New form'}
          </Button>
        ) : null}
      </header>

      {creating ? (
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Form name
              </span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Demo request"
                maxLength={255}
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Privacy policy URL
              </span>
              <Input
                value={privacyPolicyUrl}
                onChange={(e) => setPrivacyPolicyUrl(e.target.value)}
                placeholder="https://example.com/privacy"
                inputMode="url"
              />
              {/* Not a preference — Meta refuses to create a lead form
                  without one. */}
              <span className="mt-1 block text-xs text-muted-foreground">
                Required by Meta for every lead form.
              </span>
            </label>
          </div>

          <fieldset>
            <legend className="mb-2 text-xs font-medium text-foreground">
              What to ask
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {QUESTION_TYPES.map((question) => {
                const required = 'required' in question && question.required;
                const checked = selected.includes(question.value) || required;
                return (
                  <label
                    key={question.value}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={required}
                      onCheckedChange={(next) =>
                        setSelected((prev) =>
                          next
                            ? [...prev, question.value]
                            : prev.filter((v) => v !== question.value),
                        )
                      }
                    />
                    {question.label}
                    {required ? (
                      <span className="text-xs text-muted-foreground">
                        (required)
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              A phone number is required because a lead without one cannot be
              saved as a contact — this CRM needs a phone, an Instagram id or a
              web visitor id to create one, and a form submission has neither of
              the others.
            </p>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Thank-you headline
              </span>
              <Input
                value={thankYouTitle}
                onChange={(e) => setThankYouTitle(e.target.value)}
                placeholder="Thanks — we’ll be in touch"
                maxLength={120}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Thank-you message
              </span>
              <Textarea
                value={thankYouBody}
                onChange={(e) => setThankYouBody(e.target.value)}
                placeholder="We have your details and will message you on WhatsApp shortly."
                rows={2}
                maxLength={500}
              />
            </label>
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !name.trim() || !privacyPolicyUrl.trim()}
              onClick={() => void create()}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Create form
            </Button>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-border bg-card">
        {forms === null ? (
          <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading forms…
          </div>
        ) : forms.length === 0 ? (
          <div className="p-8 text-center">
            <FileText className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              No instant forms on this page yet.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {forms.map((form) => (
              <li
                key={form.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {form.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {form.questions.map((q) => q.type.toLowerCase()).join(', ')}
                  </p>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  {!form.questions.some((q) => q.type === 'PHONE') ? (
                    <span className="flex items-center gap-1 text-accent-amber">
                      <AlertTriangle className="size-3" />
                      No phone question — leads cannot be saved
                    </span>
                  ) : null}
                  <span className="text-muted-foreground">
                    {formatCount(form.leadsCount)} leads
                  </span>
                  <span className="text-muted-foreground">{form.status}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
