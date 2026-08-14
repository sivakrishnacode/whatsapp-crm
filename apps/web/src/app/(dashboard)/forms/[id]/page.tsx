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
import FormSettingsPanel from '@/components/forms/form-settings-panel';
import FormSharePanel from '@/components/forms/form-share-panel';
import FormAvailabilityPanel, {
  type Availability,
} from '@/components/forms/form-availability-panel';

interface FormData {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: 'form' | 'booking';
  status: 'draft' | 'published' | 'archived';
  fields: unknown[];
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
  const [localFields, setLocalFields] = useState<unknown[]>([]);
  const [activeTab, setActiveTab] = useState('builder');

  /**
   * Derived from the LOCAL field list, not the saved one, so adding a Time
   * slot field reveals the Availability tab immediately rather than after a
   * save-and-reload.
   */
  const hasSlotField = (localFields.length ? localFields : (form?.fields ?? []))
    .some((f) => (f as { type?: string })?.type === 'appointment_slot');

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/forms/${id}`);
        if (!res.ok) throw new Error('Not found');
        const data = await res.json();
        setForm(data);
        setLocalFields(data.fields ?? []);
      } catch {
        toast.error('Form not found');
        router.push('/forms');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id, router]);

  const handleFieldsChange = useCallback((fields: unknown[]) => {
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
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isPublished = form.status === 'published';

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
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
        <TabsList className="mx-4 mt-3 self-start">
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
          <TabsTrigger
            value="submissions"
            id="tab-submissions"
            onClick={() => router.push(`/forms/${id}/submissions`)}
          >
            <BarChart2 className="mr-2 h-4 w-4" />
            Submissions ({form.submission_count})
          </TabsTrigger>
          {form.status === 'published' && (
            <TabsTrigger value="preview" id="tab-preview">
              <Eye className="mr-2 h-4 w-4" />
              Preview
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent
          value="builder"
          className="flex-1 overflow-auto p-4"
        >
          <FormBuilder
            fields={localFields as never}
            onChange={handleFieldsChange}
          />
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
