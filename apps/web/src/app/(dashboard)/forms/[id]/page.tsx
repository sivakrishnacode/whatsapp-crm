'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Save,
  Globe,
  Clock,
  Loader2,
  Eye,
  Settings2,
  BarChart2,
  Share2,
  CalendarClock,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

// Lazily imported builder components
import FormBuilder from '@/components/forms/form-builder';
import type { FormBuilderField } from '@/lib/forms/field-types';
import FormSettingsPanel from '@/components/forms/form-settings-panel';
import FormSharePanel from '@/components/forms/form-share-panel';
import FormAvailabilityPanel, {
  type Availability,
} from '@/components/forms/form-availability-panel';
import FormSubmissionsPanel from '@/components/forms/form-submissions-panel';

interface FormData {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: 'form' | 'booking';
  status: 'draft' | 'published' | 'archived';
  fields: FormBuilderField[];
  settings: Record<string, unknown>;
  notify: Record<string, unknown>;
  /** NULL = takes no bookings. Set on the Availability tab. */
  availability: Availability | null;
  submission_count: number;
  public_url: string;
}

export default function FormBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [form, setForm] = useState<FormData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [localFields, setLocalFields] = useState<FormBuilderField[]>([]);
  const [activeTab, setActiveTab] = useState('builder');
  /**
   * Seeded from the form record so the tab has a number before the table
   * is ever opened, then corrected by the panel once it has really
   * counted. Otherwise the badge keeps quoting a stale `submission_count`
   * from whenever the form was last saved.
   */
  const [submissionCount, setSubmissionCount] = useState(0);

  /**
   * Derived from the LOCAL field list, not the saved one, so adding a Time
   * slot field reveals the Availability tab immediately rather than after a
   * save-and-reload.
   */
  const hasSlotField = (
    localFields.length ? localFields : (form?.fields ?? [])
  ).some((f) => f?.type === 'appointment_slot');

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/forms/${id}`);
        if (!res.ok) throw new Error('Not found');
        const data = await res.json();
        setForm(data);
        setLocalFields(data.fields ?? []);
        setSubmissionCount(data.submission_count ?? 0);
      } catch {
        toast.error('Form not found');
        router.push('/forms');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id, router]);

  const handleFieldsChange = useCallback((fields: FormBuilderField[]) => {
    setLocalFields(fields);
    setDirty(true);
  }, []);

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/forms/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: localFields }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? 'Save failed');
      }
      const updated = await res.json();
      setForm(updated);
      setLocalFields(updated.fields ?? []);
      setDirty(false);
      toast.success('Form saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save form');
    } finally {
      setSaving(false);
    }
  };

  const handleTogglePublish = async () => {
    if (!form) return;
    // Save first if there are unsaved changes
    if (dirty) await handleSave();
    const endpoint = form.status === 'published' ? 'unpublish' : 'publish';
    setPublishing(true);
    try {
      const res = await fetch(`/api/forms/${id}/${endpoint}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? 'Failed');
      }
      const updated = await res.json();
      setForm(updated);
      toast.success(
        updated.status === 'published' ? 'Form published' : 'Form unpublished',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update form');
    } finally {
      setPublishing(false);
    }
  };

  if (loading || !form) {
    return (
      <div className="bg-background fixed inset-0 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isPublished = form.status === 'published';

  return (
    /*
     * Full viewport, escaping the dashboard's rail, panel and header —
     * the same `fixed inset-0` the automation editor uses.
     *
     * Building a form is a canvas job: the palette, the form itself and
     * the settings panel are three columns that all want vertical room,
     * and inside the shell's scrolling `<main>` they were sharing width
     * with navigation nobody needs while dragging a field. The back arrow
     * in the header is the way out, which is why it is the first thing in
     * the bar.
     */
    <div className="bg-background fixed inset-0 z-40 flex flex-col">
      {/* Top bar */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b px-4 py-3">
        <Button
          id="btn-back-to-forms"
          variant="ghost"
          size="icon"
          onClick={() => router.push('/forms')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-base font-semibold">{form.name}</h1>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                'text-xs',
                isPublished
                  ? 'border-green-300 text-accent-green'
                  : 'border-gray-300 text-muted-foreground',
              )}
            >
              {isPublished ? (
                <Globe className="mr-1 h-3 w-3" />
              ) : (
                <Clock className="mr-1 h-3 w-3" />
              )}
              {isPublished ? 'Published' : 'Draft'}
            </Badge>
            {dirty && (
              <span className="text-xs text-accent-amber">Unsaved changes</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            id="btn-save-form"
            variant="outline"
            size="sm"
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            {saving ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <Save className="mr-2 h-3 w-3" />
            )}
            Save
          </Button>
          <Button
            id="btn-publish-form"
            size="sm"
            disabled={publishing}
            variant={isPublished ? 'outline' : 'default'}
            onClick={handleTogglePublish}
          >
            {publishing ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : isPublished ? (
              <Clock className="mr-2 h-3 w-3" />
            ) : (
              <Globe className="mr-2 h-3 w-3" />
            )}
            {isPublished ? 'Unpublish' : 'Publish'}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <TabsList className="mx-4 mt-3 flex-shrink-0 self-start">
          <TabsTrigger value="builder" id="tab-builder">
            <Settings2 className="mr-2 h-4 w-4" />
            Builder
          </TabsTrigger>
          <TabsTrigger value="settings" id="tab-settings">
            <Settings2 className="mr-2 h-4 w-4" />
            Settings
          </TabsTrigger>
          {/*
            Only for forms that actually carry a time picker. An
            `appointment_slot` field is what makes a form a booking form — no
            separate flag to keep in sync — so the tab appears exactly when it
            can do something.
          */}
          {hasSlotField && (
            <TabsTrigger value="availability" id="tab-availability">
              <CalendarClock className="mr-2 h-4 w-4" />
              Availability
            </TabsTrigger>
          )}
          <TabsTrigger value="share" id="tab-share">
            <Share2 className="mr-2 h-4 w-4" />
            Share
          </TabsTrigger>
          {/* An ordinary tab, not a navigation. Leaving the full-screen
              editor to read a table and then having to come back is the
              long way round to a question ("did anyone fill it in?") that
              gets asked while building. */}
          <TabsTrigger value="submissions" id="tab-submissions">
            <BarChart2 className="mr-2 h-4 w-4" />
            Submissions ({submissionCount})
          </TabsTrigger>
          {form.status === 'published' && (
            <TabsTrigger value="preview" id="tab-preview">
              <Eye className="mr-2 h-4 w-4" />
              Preview
            </TabsTrigger>
          )}
        </TabsList>

        {/* `overflow-hidden`, not `auto`: the builder is three columns that
            scroll independently, and an outer scrollbar would move the
            palette and the inspector off screen together with the form. */}
        <TabsContent
          value="builder"
          className="min-h-0 flex-1 overflow-hidden p-4"
        >
          <FormBuilder fields={localFields} onChange={handleFieldsChange} />
        </TabsContent>

        <TabsContent value="settings" className="flex-1 overflow-auto p-4">
          <FormSettingsPanel
            form={form as never}
            onUpdate={(updated) => setForm({ ...form, ...updated })}
          />
        </TabsContent>

        <TabsContent value="availability" className="flex-1 overflow-auto">
          <FormAvailabilityPanel
            formId={form.id}
            hasSlotField={hasSlotField}
            availability={form.availability}
            onUpdate={(availability) =>
              setForm((prev) => (prev ? { ...prev, availability } : prev))
            }
          />
        </TabsContent>

        <TabsContent value="share" className="flex-1 overflow-auto p-4">
          <FormSharePanel form={form as never} />
        </TabsContent>

        {/* Unmounted while inactive (base-ui `keepMounted` defaults to
            false), so submissions are fetched when the tab is first opened
            rather than on every visit to the editor. */}
        <TabsContent value="submissions" className="flex-1 overflow-auto p-4">
          <FormSubmissionsPanel
            formId={form.id}
            formName={form.name}
            fields={localFields}
            onCountChange={setSubmissionCount}
          />
        </TabsContent>

        <TabsContent value="preview" className="flex-1 overflow-hidden">
          <iframe
            src={form.public_url}
            className="h-full w-full border-0"
            title="Form preview"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
