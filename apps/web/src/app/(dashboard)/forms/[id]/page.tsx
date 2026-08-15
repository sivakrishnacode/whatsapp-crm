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
  Settings2,
  Inbox,
  Share2,
  CalendarClock,
  CalendarCheck2,
  LayoutPanelLeft,
  ExternalLink,
} from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
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
import FormAppointmentsPanel from '@/components/forms/form-appointments-panel';
import {
  EDITOR_CONTAINER,
  EditorScreen,
} from '@/components/forms/form-editor-shell';
import { resolveFormTheme, type FormTheme } from '@/lib/forms/theme';

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
  /**
   * Appearance, edited on the builder's Design panel and written by the
   * SAME Save as the fields. It used to be its own tab with its own Save,
   * which meant two ways to have unsaved work on one screen.
   */
  const [localTheme, setLocalTheme] = useState<FormTheme>(() =>
    resolveFormTheme(undefined)
  );
  const [activeTab, setActiveTab] = useState('builder');
  /**
   * Seeded from the form record so the tab has a number before the table
   * is ever opened, then corrected by the panel once it has really
   * counted. Otherwise the badge keeps quoting a stale `submission_count`
   * from whenever the form was last saved.
   */
  const [submissionCount, setSubmissionCount] = useState(0);
  const [appointmentCount, setAppointmentCount] = useState<number | null>(null);

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
        setLocalTheme(resolveFormTheme(data.settings?.theme));
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
        // Fields and theme together — settings are merged server-side, so
        // sending `theme` alone cannot clobber the other settings.
        body: JSON.stringify({
          fields: localFields,
          settings: { theme: localTheme },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? 'Save failed');
      }
      const updated = await res.json();
      setForm(updated);
      setLocalFields(updated.fields ?? []);
      setLocalTheme(resolveFormTheme(updated.settings?.theme));
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
        updated.status === 'published' ? 'Form published' : 'Form unpublished'
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
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
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
      {/* Top bar. The rule is full-bleed; what sits on it shares the
          content's cap and gutter, so the back arrow, the first tab and the
          first card on every screen line up on one left edge. */}
      <div className="border-border/60 flex-shrink-0 border-b">
        <div className={cn(EDITOR_CONTAINER, 'flex items-center gap-3 py-3')}>
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
                  // Ink + surface token pair, not a raw palette class:
                  // `border-green-300`/`border-gray-300` have no dark variant
                  // and this app's default theme is dark.
                  isPublished
                    ? 'border-accent-green/40 bg-accent-green-surface text-accent-green'
                    : 'text-muted-foreground border-border'
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
                <span className="text-accent-amber text-xs">
                  Unsaved changes
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* The published page itself, one click from the editor. Every
              other route to it goes through the Share tab. */}
            {isPublished && (
              <a
                id="btn-open-public-form"
                href={form.public_url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the live form"
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'sm' }),
                  'text-muted-foreground hover:text-foreground hidden sm:inline-flex'
                )}
              >
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                Open
              </a>
            )}
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
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        // `gap-0`: the primitive puts a gap between the list and the panel,
        // and the bar below owns its own spacing. `min-h-0` is what lets the
        // panels shrink, without which the scroll container never engages.
        className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
      >
        {/* A bar of its own, ruled off from the screen below it and on the
            same cap and gutter as the title above and every screen below —
            so a tab and the screen it opens share a left edge. It scrolls
            horizontally rather than wrapping: a second row of tabs would
            change the header height and move everything underneath it. */}
        <div className="border-border/60 flex-shrink-0 border-b">
          <div
            className={cn(
              EDITOR_CONTAINER,
              '[scrollbar-width:none] overflow-x-auto py-2 [&::-webkit-scrollbar]:hidden'
            )}
          >
            <TabsList className="w-max">
              {/* Build is the builder, the design controls and the preview —
                three tabs that were three views of one form. */}
              <TabsTrigger value="builder" id="tab-builder">
                <LayoutPanelLeft className="mr-2 h-4 w-4" />
                Build
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
              {/* Only for forms that actually take bookings — same rule as
                Availability, and for the same reason: an appointments list
                for a form with no time picker can never have a row. */}
              {hasSlotField && (
                <TabsTrigger value="appointments" id="tab-appointments">
                  <CalendarCheck2 className="mr-2 h-4 w-4" />
                  Appointments
                  <TabCount value={appointmentCount} />
                </TabsTrigger>
              )}
              <TabsTrigger value="submissions" id="tab-submissions">
                <Inbox className="mr-2 h-4 w-4" />
                Submissions
                <TabCount value={submissionCount} />
              </TabsTrigger>
            </TabsList>
          </div>
        </div>

        {/* `overflow-hidden`, not `auto`: the builder is three columns that
            scroll independently, and an outer scrollbar would move the
            palette and the inspector off screen together with the form.
            Same gutter as every other screen, so the palette's left edge
            sits under the Build tab that opened it. */}
        <TabsContent
          value="builder"
          className={cn(
            EDITOR_CONTAINER,
            'flex min-h-0 flex-1 flex-col overflow-hidden py-4'
          )}
        >
          <FormBuilder
            fields={localFields}
            onChange={handleFieldsChange}
            theme={localTheme}
            onThemeChange={(next) => {
              setLocalTheme(next);
              setDirty(true);
            }}
            formName={form.name}
            description={form.description}
            submitLabel={
              (form.settings as { submit_label?: string })?.submit_label ??
              'Submit'
            }
          />
        </TabsContent>

        {/*
          Every other tab is a SCREEN: this panel is the scroll container and
          nothing else, and the panel component inside it renders an
          `EditorScreen` that owns the width, the gutters and the heading.
          One place decides those, so switching tabs no longer moves the
          content sideways.
        */}
        <TabsContent
          value="settings"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <FormSettingsPanel
            form={form as never}
            onUpdate={(updated) => setForm({ ...form, ...updated })}
          />
        </TabsContent>

        <TabsContent
          value="availability"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <FormAvailabilityPanel
            formId={form.id}
            hasSlotField={hasSlotField}
            availability={form.availability}
            onUpdate={(availability) =>
              setForm((prev) => (prev ? { ...prev, availability } : prev))
            }
          />
        </TabsContent>

        <TabsContent value="share" className="min-h-0 flex-1 overflow-y-auto">
          <FormSharePanel form={form as never} />
        </TabsContent>

        {/* Unmounted while inactive (base-ui `keepMounted` defaults to
            false), so submissions are fetched when the tab is first opened
            rather than on every visit to the editor. */}
        <TabsContent
          value="appointments"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <FormAppointmentsPanel
            formId={form.id}
            onCountChange={setAppointmentCount}
          />
        </TabsContent>

        <TabsContent
          value="submissions"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {/* The heading lives here rather than in the panel: the panel is
              rendered a second time by `/forms/[id]/submissions`, inside the
              dashboard shell, which supplies a heading of its own. */}
          <EditorScreen
            title="Submissions"
            description="Every response this form has collected. The export carries all fields, not just the columns shown."
          >
            <FormSubmissionsPanel
              formId={form.id}
              formName={form.name}
              fields={localFields}
              onCountChange={setSubmissionCount}
            />
          </EditorScreen>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The number beside a tab label.
 *
 * A pill rather than "Submissions (3)": the count is a different kind of
 * thing from the name, and inside the label it changes the width of the tab
 * every time it lands — which shifts every tab to the right of it.
 * `null` means "not counted yet" and renders nothing, so the pill never
 * flashes a wrong zero before the panel has fetched.
 */
function TabCount({ value }: { value: number | null }) {
  if (value === null) return null;
  return (
    <span className="bg-foreground/10 text-muted-foreground ml-1.5 rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums">
      {value}
    </span>
  );
}
