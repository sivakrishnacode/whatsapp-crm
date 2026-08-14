'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  AlertCircle,
  Pencil,
  RotateCcw,
  Upload,
  X,
  Code2,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useObjectUrl } from '@/hooks/use-object-url';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MessageTemplate, TemplateParameterFormat } from '@/types';
import { templateStatusConfig } from '@/lib/template-status';
import { TEMPLATE_LIMITS } from '@/lib/whatsapp/template-validators';
import {
  buildTemplateSubmitPayload,
  emptyCard,
  emptyTemplateForm,
  formFromTemplate,
  resizeSamples,
  templateTypeFromRow,
  typeNeedsMedia,
  variableTokens,
  TEMPLATE_TYPE_OPTIONS,
  type TemplateFormData,
  type TemplateTypeOption,
} from '@/lib/whatsapp/template-form';
import {
  mediaFormatForType,
  rollbackTemplateMedia,
  uploadPendingTemplateMedia,
  validateTemplateMediaFile,
  TEMPLATE_MEDIA_RULES,
} from '@/lib/whatsapp/template-media';
import { templateWarnings } from '@/lib/whatsapp/template-warnings';
import { TemplateApiDialog } from './template-api-dialog';
import { TemplateBodyEditor } from './template-body-editor';
import { TemplateButtonsEditor } from './template-buttons-editor';
import { TemplateCardsEditor } from './template-cards-editor';
import { TemplateGallery } from './template-gallery';
import { TemplatePreview } from './template-preview';
import { TemplateSourceChooser } from './template-source-chooser';

const CATEGORIES = ['Marketing', 'Utility', 'Authentication'] as const;

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-600/20 text-accent-purple border-purple-600/30',
  Utility: 'bg-info-surface text-info border-info/30',
  Authentication: 'bg-warning-surface text-warning border-warning/30',
};

const COMMON_LANGUAGE_CODES = [
  'en_US',
  'en_GB',
  'en',
  'es',
  'es_ES',
  'es_MX',
  'fr',
  'fr_FR',
  'de',
  'it',
  'pt_BR',
  'pt_PT',
  'nl',
  'pl',
  'ru',
  'tr',
  'lt',
];

export function TemplateManager() {
  const supabase = createClient();
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [form, setForm] = useState<TemplateFormData>(emptyTemplateForm);
  // Non-null when the dialog is editing an existing row — switches the
  // submit handler from POST /submit to PATCH /[id] and changes the
  // dialog title + CTA. Set to the template id to pre-fill from a row.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Template selected for the confirm-delete dialog. The destructive
  // action goes through this two-step so a slip on the trash icon
  // doesn't take the template off Meta as well as locally.
  const [templateToDelete, setTemplateToDelete] =
    useState<MessageTemplate | null>(null);
  // Template whose API send-example is on screen.
  const [apiExampleFor, setApiExampleFor] = useState<MessageTemplate | null>(
    null,
  );
  // "New Template" opens the source chooser first: blank editor, or a
  // pre-built starter from the gallery.
  const [chooserOpen, setChooserOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const headerFileRef = useRef<HTMLInputElement>(null);

  // A picked-but-not-uploaded header file is previewed from a blob URL.
  // Nothing touches storage until handleSubmit runs — that is what stops
  // a closed dialog from leaving an orphan in the bucket.
  const headerBlobUrl = useObjectUrl(form.header_media_file);

  // Advisory only — things that make a Meta rejection likely but that we
  // won't block on (see template-warnings.ts for why each is a warning).
  const warnings = useMemo(() => templateWarnings(form), [form]);

  const isCarousel = form.template_type === 'CAROUSEL';

  // Placeholder tokens drive the sample-value rows. Positional templates
  // yield ['1','2']; named ones yield ['first_name','order_id'] — the UI
  // treats both the same way from here on.
  const bodyTokens = useMemo(
    () => variableTokens(form.body_text, form.parameter_format),
    [form.body_text, form.parameter_format],
  );
  const headerTokens = useMemo(
    () =>
      form.template_type === 'TEXT'
        ? variableTokens(form.header_content, form.parameter_format)
        : [],
    [form.template_type, form.header_content, form.parameter_format],
  );

  // Keep body_samples exactly as long as the placeholder list.
  useEffect(() => {
    setForm((prev) => {
      const next = resizeSamples(prev.body_samples, bodyTokens.length);
      return next === prev.body_samples ? prev : { ...prev, body_samples: next };
    });
  }, [bodyTokens.length]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    fetchTemplates(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  async function fetchTemplates(userId: string) {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('message_templates')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setTemplates(data || []);
    } catch (err) {
      console.error('Failed to fetch templates:', err);
      toast.error('Failed to load templates');
    } finally {
      setLoading(false);
    }
  }

  function openEdit(template: MessageTemplate) {
    setEditingId(template.id);
    setForm(formFromTemplate(template));
    setDialogOpen(true);
  }

  function openCreate() {
    setChooserOpen(true);
  }

  function startFromScratch() {
    setChooserOpen(false);
    setEditingId(null);
    setForm(emptyTemplateForm);
    setDialogOpen(true);
  }

  /**
   * Fill the editor from a library starter — explicitly WITHOUT
   * submitting. The user reviews and edits, then submits themselves.
   */
  function startFromLibrary(libraryForm: TemplateFormData) {
    setEditingId(null);
    setForm(libraryForm);
    setDialogOpen(true);
    toast.success('Template loaded — edit it, then submit for approval.');
  }

  function changeTemplateType(value: TemplateTypeOption) {
    setForm((prev) => ({
      ...prev,
      template_type: value,
      // A carousel needs at least one card to be editable at all; seed
      // one on the switch rather than showing an empty editor.
      cards:
        value === 'CAROUSEL' && prev.cards.length === 0
          ? [emptyCard()]
          : prev.cards,
    }));
  }

  async function handleSubmit() {
    // AUTHENTICATION is blocked by the persistent banner + disabled
    // submit button; this is a defensive second line of defense.
    if (form.category === 'Authentication') return;

    // Storage paths written during this submit. If the Meta call fails we
    // remove them again, so a rejected template doesn't leave media
    // behind — the whole point of deferring the upload to here.
    let uploadedPaths: string[] = [];

    try {
      setSubmitting(true);
      const isEdit = editingId !== null;

      const { form: resolvedForm, paths } = await uploadPendingTemplateMedia(form);
      uploadedPaths = paths;
      // Keep the resolved URLs in state so a retry after a failed submit
      // doesn't upload the same file twice.
      if (paths.length > 0) setForm(resolvedForm);

      const url = isEdit
        ? `/api/whatsapp/templates/${editingId}`
        : '/api/whatsapp/templates/submit';
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTemplateSubmitPayload(resolvedForm)),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error || `${isEdit ? 'Edit' : 'Submit'} failed (HTTP ${res.status})`,
        );
      }
      uploadedPaths = [];
      // Refresh first, then close — re-opening the dialog
      // immediately should not show a stale list.
      if (user) await fetchTemplates(user.id);
      toast.success(
        data.dry_run
          ? isEdit
            ? 'Template updated (dry-run — no Meta call)'
            : 'Template saved (dry-run — no Meta call)'
          : isEdit
            ? 'Edit submitted — Meta typically reviews within 24 hours.'
            : 'Submitted to Meta — typical review time is 24 hours. Status updates automatically.',
      );
      setDialogOpen(false);
      setForm(emptyTemplateForm);
      setEditingId(null);
    } catch (err) {
      console.error('Submit error:', err);
      // Fire-and-forget: the user needs to see why the submit failed, not
      // a second error about storage cleanup.
      void rollbackTemplateMedia(uploadedPaths);
      toast.error(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSyncFromMeta() {
    if (!user) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/templates/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Sync failed (HTTP ${res.status})`);
      }
      const changes = [
        data.inserted ? `${data.inserted} new` : '',
        data.updated ? `${data.updated} updated` : '',
        data.deleted ? `${data.deleted} removed` : '',
      ].filter(Boolean);
      toast.success(
        `Synced ${data.total} template${data.total === 1 ? '' : 's'} from Meta` +
          (changes.length ? ` (${changes.join(', ')})` : ''),
      );
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const preview = data.errors.slice(0, 3).map(
          (e: { name: string; language: string; message: string }) =>
            `${e.name} (${e.language})`,
        );
        const suffix =
          data.errors.length > 3 ? `, +${data.errors.length - 3} more` : '';
        toast.error(`Failed to sync: ${preview.join(', ')}${suffix}`);
      }
      if (data.truncated) {
        // Use error (not warning) so the message survives long
        // enough to read — sonner's `warning` auto-dismisses on
        // the same short timer as `success`.
        toast.error(
          'Synced the first 2000 templates only — your account has more. Sync again to continue, or contact support if this persists.',
          { duration: 10000 },
        );
      }
      await fetchTemplates(user.id);
    } catch (err) {
      console.error('Template sync error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to sync templates');
    } finally {
      setSyncing(false);
    }
  }

  async function confirmDelete() {
    const target = templateToDelete;
    if (!target || deletingId) return;
    setDeletingId(target.id);
    try {
      // Route handler scopes the Meta delete via hsm_id (so sibling
      // language variants survive) and falls through to remove the
      // local row. Local-only rows skip the Meta call.
      const res = await fetch(`/api/whatsapp/templates/${target.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Delete failed (HTTP ${res.status})`);
      }
      toast.success('Template deleted');
      setTemplates((prev) => prev.filter((t) => t.id !== target.id));
      setTemplateToDelete(null);
    } catch (err) {
      console.error('Delete error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to delete template');
    } finally {
      setDeletingId(null);
    }
  }

  /**
   * Validate and stage a header file — no upload. The bytes stay in the
   * browser until submit, so closing the dialog costs nothing and leaves
   * nothing in storage.
   */
  function stageHeaderMediaFile(file: File) {
    const format = mediaFormatForType(form.template_type);
    if (!format) return;
    const problem = validateTemplateMediaFile(format, file);
    if (problem) {
      toast.error(problem);
      return;
    }
    // Picking a file supersedes any pasted URL — otherwise the payload
    // builder would have two sources of truth for the same header.
    setForm((f) => ({ ...f, header_media_file: file, header_media_url: '' }));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const headerNeedsMedia = typeNeedsMedia(form.template_type);
  const mediaFormat = mediaFormatForType(form.template_type);
  const mediaRules = mediaFormat ? TEMPLATE_MEDIA_RULES[mediaFormat] : null;

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title="Message templates"
        description={
          'Create templates and submit them to Meta for approval. Use "Sync from Meta" to pull templates approved elsewhere.'
        }
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleSyncFromMeta}
              disabled={syncing}
              title="Pull approved templates from your Meta WhatsApp Business Account"
            >
              <RefreshCw className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync from Meta'}
            </Button>
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              New Template
            </Button>
          </div>
        }
      />

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">No templates yet.</p>
            <p className="text-muted-foreground text-xs mt-1">
              Create your first message template to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {templates.map((template) => {
            const statusKey = template.status || 'DRAFT';
            const status = templateStatusConfig[statusKey];
            const typeLabel = templateTypeFromRow(template);
            return (
              <Card key={template.id}>
                <CardContent className="flex items-start justify-between pt-4">
                  <div className="space-y-2 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium text-foreground">{template.name}</h3>
                      <Badge
                        className={`text-xs border ${categoryColors[template.category] || ''}`}
                      >
                        {template.category}
                      </Badge>
                      <Badge className={`text-xs border ${status.classes}`}>
                        {status.label}
                      </Badge>
                      {typeLabel !== 'NONE' && (
                        <span
                          className="text-[10px] uppercase tracking-wide text-muted-foreground"
                          title="Template type"
                        >
                          {typeLabel}
                        </span>
                      )}
                      {template.language && (
                        <span className="text-xs text-muted-foreground uppercase">
                          {template.language}
                        </span>
                      )}
                      {template.quality_score && (
                        <span
                          className={`text-[10px] uppercase font-medium ${
                            template.quality_score === 'GREEN'
                              ? 'text-success'
                              : template.quality_score === 'YELLOW'
                                ? 'text-warning'
                                : 'text-destructive'
                          }`}
                          title="Meta quality score"
                        >
                          {template.quality_score}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {template.body_text}
                    </p>
                    {template.footer_text && (
                      <p className="text-xs text-muted-foreground italic">
                        {template.footer_text}
                      </p>
                    )}
                    {(template.rejection_reason || template.submission_error) && (
                      <div className="flex items-start gap-1.5 text-xs text-destructive bg-destructive-surface border border-destructive/30 rounded px-2 py-1.5">
                        <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
                        <span>
                          {template.rejection_reason || template.submission_error}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setApiExampleFor(template)}
                      aria-label="Show API send example"
                      title="Show the API request that sends this template"
                      className="h-8 w-8 text-muted-foreground hover:bg-muted hover:text-primary"
                    >
                      <Code2 className="size-4" />
                    </Button>
                    {statusKey === 'APPROVED' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(template)}
                        title="Editing triggers Meta re-review — status flips to PENDING."
                        aria-label="Edit template"
                        className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 px-2"
                      >
                        <Pencil className="size-3.5" />
                        Edit
                      </Button>
                    )}
                    {(statusKey === 'REJECTED' || statusKey === 'PAUSED') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(template)}
                        title="Edit the template and resubmit to Meta for review."
                        aria-label="Edit and resubmit template"
                        className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 px-2"
                      >
                        <RotateCcw className="size-3.5" />
                        Resubmit
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setTemplateToDelete(template)}
                      disabled={deletingId === template.id}
                      aria-label={
                        template.meta_template_id
                          ? 'Delete template from Meta and locally'
                          : 'Delete template locally'
                      }
                      title={
                        template.meta_template_id
                          ? 'Delete from Meta and locally'
                          : 'Delete locally'
                      }
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-8 w-8"
                    >
                      {deletingId === template.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <TemplateApiDialog
        template={apiExampleFor}
        onOpenChange={(open) => {
          if (!open) setApiExampleFor(null);
        }}
      />

      <TemplateSourceChooser
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        onScratch={startFromScratch}
        onLibrary={() => {
          setChooserOpen(false);
          setGalleryOpen(true);
        }}
      />

      <TemplateGallery
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        onUse={startFromLibrary}
      />

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            // Any staged file is dropped here with nothing to clean up in
            // storage — it was never uploaded.
            setEditingId(null);
            setForm(emptyTemplateForm);
          }
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {editingId ? 'Edit Message Template' : 'New Message Template'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {editingId
                ? 'Save your changes to re-submit to Meta. Status will flip back to PENDING during review.'
                : 'Build a template and submit it to Meta for approval. Once approved, you can use it in broadcasts and the inbox.'}
            </DialogDescription>
          </DialogHeader>

          {form.category === 'Authentication' && (
            <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning-surface px-3 py-2 text-xs text-warning">
              <AlertCircle className="size-4 mt-0.5 shrink-0" />
              <p>
                AUTHENTICATION templates have a fixed body + OTP button shape
                that needs a different builder. Create them in Meta WhatsApp
                Manager for now and use <strong>Sync from Meta</strong> to
                bring them in.
              </p>
            </div>
          )}

          {/* Form on the left, live preview pinned on the right — the
              preview is the only way to judge sample values before Meta's
              reviewer does. */}
          <div className="grid gap-6 py-2 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Template Name</Label>
                <Input
                  placeholder="e.g. order_confirmation"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  disabled={editingId !== null}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:opacity-60 disabled:cursor-not-allowed"
                />
                <p className="text-[11px] text-muted-foreground">
                  {editingId
                    ? 'Name is fixed once a template exists on Meta — create a new template to change it.'
                    : 'Lowercase letters, digits, and underscores only.'}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Category</Label>
                  <Select
                    value={form.category}
                    onValueChange={(val) =>
                      setForm({
                        ...form,
                        category: val as MessageTemplate['category'],
                      })
                    }
                  >
                    <SelectTrigger className="w-full bg-muted border-border text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      {CATEGORIES.map((cat) => (
                        <SelectItem
                          key={cat}
                          value={cat}
                          className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                        >
                          {cat}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-muted-foreground">Language</Label>
                  <Input
                    list="template-language-codes"
                    placeholder="en_US"
                    value={form.language}
                    onChange={(e) =>
                      setForm({ ...form, language: e.target.value })
                    }
                    disabled={editingId !== null}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                  <datalist id="template-language-codes">
                    {COMMON_LANGUAGE_CODES.map((code) => (
                      <option key={code} value={code} />
                    ))}
                  </datalist>
                  <p className="text-[11px] text-muted-foreground">
                    {editingId
                      ? 'Language is fixed once a template exists on Meta.'
                      : (
                          <>
                            Must match the exact code on Meta — <code>en_US</code>{' '}
                            and <code>en</code> are distinct.
                          </>
                        )}
                  </p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Template Type</Label>
                  <Select
                    value={form.template_type}
                    onValueChange={(val) => {
                      if (!val) return;
                      changeTemplateType(val as TemplateTypeOption);
                    }}
                  >
                    <SelectTrigger className="w-full bg-muted border-border text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      {TEMPLATE_TYPE_OPTIONS.map((opt) => (
                        <SelectItem
                          key={opt.value}
                          value={opt.value}
                          className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                        >
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    {
                      TEMPLATE_TYPE_OPTIONS.find(
                        (o) => o.value === form.template_type,
                      )?.hint
                    }
                  </p>
                </div>

                <div className="space-y-2">
                  <Label className="text-muted-foreground">Variables</Label>
                  <Select
                    value={form.parameter_format}
                    onValueChange={(val) => {
                      if (!val) return;
                      setForm({
                        ...form,
                        parameter_format: val as TemplateParameterFormat,
                      });
                    }}
                    disabled={editingId !== null}
                  >
                    <SelectTrigger className="w-full bg-muted border-border text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      <SelectItem
                        value="POSITIONAL"
                        className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                      >
                        Numbered — {'{{1}}'}
                      </SelectItem>
                      <SelectItem
                        value="NAMED"
                        className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                      >
                        Named — {'{{customer_name}}'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    {editingId
                      ? 'Fixed once a template exists on Meta.'
                      : 'A template uses one scheme throughout — Meta rejects a mix, so switching means rewriting existing placeholders.'}
                  </p>
                </div>
              </div>

              {form.template_type === 'TEXT' && (
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Header text</Label>
                  <Input
                    id="template-header-text"
                    aria-label="Header text"
                    placeholder={`Header text (max ${TEMPLATE_LIMITS.headerTextMaxLength} chars, one optional variable)`}
                    value={form.header_content}
                    onChange={(e) =>
                      setForm({ ...form, header_content: e.target.value })
                    }
                    maxLength={TEMPLATE_LIMITS.headerTextMaxLength}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  />
                  {headerTokens.length > 0 && (
                    <Input
                      id="template-header-sample"
                      aria-label="Sample value for the header variable"
                      placeholder={`Sample value for {{${headerTokens[0]}}} (required for Meta review)`}
                      value={form.header_sample}
                      onChange={(e) =>
                        setForm({ ...form, header_sample: e.target.value })
                      }
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                  )}
                </div>
              )}

              {form.template_type === 'LOCATION' && (
                <p className="rounded border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                  Location headers carry no sample. Meta takes the latitude,
                  longitude, name, and address at send time, so each message can
                  point at a different place.
                </p>
              )}

              {headerNeedsMedia && mediaRules && (
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Header media</Label>
                  <div className="flex items-center gap-2">
                    <input
                      ref={headerFileRef}
                      type="file"
                      accept={mediaRules.accept}
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) stageHeaderMediaFile(f);
                        e.target.value = '';
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => headerFileRef.current?.click()}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Choose file
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      {mediaRules.hint}
                    </span>
                  </div>

                  {form.header_media_file ? (
                    <div className="flex items-center justify-between gap-2 rounded border border-border bg-muted/40 px-2 py-1.5">
                      <span className="truncate text-xs text-foreground">
                        {form.header_media_file.name}
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          uploads on submit
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove selected file"
                          onClick={() =>
                            setForm({ ...form, header_media_file: null })
                          }
                          className="size-6 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Input
                      placeholder="https://… (or paste a public link)"
                      value={form.header_media_url}
                      onChange={(e) =>
                        setForm({ ...form, header_media_url: e.target.value })
                      }
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                  )}

                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {form.header_media_file
                      ? 'Nothing is uploaded until you submit — close this dialog and the file is simply discarded.'
                      : 'Meta fetches this once during review, so the link needs to stay live for ~24 hrs.'}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {isCarousel ? 'Message body (above the cards)' : 'Body Text'}
                </Label>
                <TemplateBodyEditor
                  value={form.body_text}
                  onChange={(text) => setForm({ ...form, body_text: text })}
                  parameterFormat={form.parameter_format}
                  maxLength={TEMPLATE_LIMITS.bodyMaxLength}
                  placeholder={
                    form.parameter_format === 'NAMED'
                      ? 'Hello {{customer_name}}, your order {{order_id}} is confirmed.'
                      : 'Hello {{1}}, your order {{2}} is confirmed.'
                  }
                  textareaId="template-body-text"
                  ariaLabel="Body text"
                />

                {bodyTokens.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <Label className="text-[11px] text-muted-foreground">
                      Sample values (Meta uses these to review your template)
                    </Label>
                    {bodyTokens.map((token, i) => (
                      <Input
                        key={token}
                        id={`template-body-sample-${i}`}
                        aria-label={`Sample value for body variable {{${token}}}`}
                        placeholder={`Sample for {{${token}}}`}
                        value={form.body_samples[i] ?? ''}
                        onChange={(e) => {
                          const next = [...form.body_samples];
                          next[i] = e.target.value;
                          setForm({ ...form, body_samples: next });
                        }}
                        className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                      />
                    ))}
                  </div>
                )}
              </div>

              {isCarousel ? (
                <TemplateCardsEditor
                  cards={form.cards}
                  onChange={(cards) => setForm({ ...form, cards })}
                  parameterFormat={form.parameter_format}
                />
              ) : (
                <>
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">
                      Footer (optional)
                    </Label>
                    <Input
                      placeholder={`Optional footer text (max ${TEMPLATE_LIMITS.footerMaxLength} chars)`}
                      value={form.footer_text}
                      onChange={(e) =>
                        setForm({ ...form, footer_text: e.target.value })
                      }
                      maxLength={TEMPLATE_LIMITS.footerMaxLength}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                  </div>

                  <TemplateButtonsEditor
                    buttons={form.buttons}
                    onChange={(buttons) => setForm({ ...form, buttons })}
                    parameterFormat={form.parameter_format}
                  />
                </>
              )}
            </div>

            <div className="lg:sticky lg:top-0 lg:self-start">
              <TemplatePreview form={form} headerBlobUrl={headerBlobUrl} />
            </div>
          </div>

          {warnings.length > 0 && (
            <div className="space-y-1.5">
              {warnings.map((w) => (
                <div
                  key={`${w.code}-${w.message}`}
                  className="flex items-start gap-2 rounded border border-warning/30 bg-warning-surface px-3 py-2 text-xs text-warning"
                >
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <p>{w.message}</p>
                </div>
              ))}
            </div>
          )}

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || form.category === 'Authentication'}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {editingId ? 'Saving…' : 'Submitting…'}
                </>
              ) : editingId ? (
                'Save & Resubmit'
              ) : (
                'Submit for Approval'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm-delete dialog. Surfacing the meta_template_id case
          separately so users understand a real Meta delete is happening,
          not just a local cleanup. */}
      <Dialog
        open={templateToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setTemplateToDelete(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Delete template?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {templateToDelete?.meta_template_id
                ? `"${templateToDelete?.name}" will be deleted from Meta and from Converse360. Active broadcasts using this template will start failing on their next send. This can't be undone.`
                : `"${templateToDelete?.name}" will be deleted from Converse360. It was never submitted to Meta, so no remote cleanup is needed.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setTemplateToDelete(null)}
              disabled={deletingId !== null}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deletingId !== null}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deletingId !== null ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
