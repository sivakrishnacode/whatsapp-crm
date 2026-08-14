'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Plus,
  Loader2,
  FileText,
  Globe,
  BarChart2,
  Copy,
  Pencil,
  Archive,
  MoreHorizontal,
  CheckCircle,
  Clock,
  ExternalLink,
  UserPlus,
  MessageSquare,
  Star,
  Calendar,
  Mail,
  Sparkles,
  LayoutTemplate,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  FORM_TEMPLATES,
  FORM_TEMPLATE_ORDER,
  type FormTemplateSlug,
} from '@/lib/forms/templates';

interface FormItem {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: 'form' | 'booking';
  status: 'draft' | 'published' | 'archived';
  submission_count: number;
  public_url: string;
  created_at: string;
  updated_at: string;
}

const TEMPLATE_ICONS = {
  UserPlus,
  MessageSquare,
  Star,
  Calendar,
  Mail,
};

export default function FormsPage() {
  const router = useRouter();
  const [forms, setForms] = useState<FormItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<FormTemplateSlug | 'blank'>('blank');
  const [newName, setNewName] = useState('');

  const fetchForms = async () => {
    try {
      const res = await fetch('/api/forms');
      if (!res.ok) throw new Error('Failed to load forms');
      const data = await res.json();
      setForms(data);
    } catch {
      toast.error('Could not load forms');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchForms();
  }, []);

  const createFormWithPayload = async (payload: {
    name: string;
    description?: string;
    fields?: unknown[];
    settings?: Record<string, unknown>;
  }) => {
    setCreating(true);
    try {
      const res = await fetch('/api/forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to create form');
      const form = await res.json();
      toast.success('Form created');
      setShowCreate(false);
      setNewName('');
      setSelectedTemplate('blank');
      router.push(`/forms/${form.id}`);
    } catch {
      toast.error('Could not create form');
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async () => {
    if (selectedTemplate !== 'blank') {
      const tmpl = FORM_TEMPLATES[selectedTemplate];
      await createFormWithPayload({
        name: newName.trim() || tmpl.name,
        description: tmpl.description,
        fields: tmpl.fields,
        settings: tmpl.settings,
      });
      return;
    }

    if (!newName.trim()) return;
    await createFormWithPayload({ name: newName.trim() });
  };

  const startFromTemplateDirectly = async (slug: FormTemplateSlug) => {
    const tmpl = FORM_TEMPLATES[slug];
    await createFormWithPayload({
      name: tmpl.name,
      description: tmpl.description,
      fields: tmpl.fields,
      settings: tmpl.settings,
    });
  };

  const handleDuplicate = async (id: string) => {
    try {
      const res = await fetch(`/api/forms/${id}/duplicate`, { method: 'POST' });
      if (!res.ok) throw new Error();
      const form = await res.json();
      toast.success('Form duplicated');
      router.push(`/forms/${form.id}`);
    } catch {
      toast.error('Could not duplicate form');
    }
  };

  const handleArchive = async (id: string) => {
    try {
      const res = await fetch(`/api/forms/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success('Form archived');
      setForms((prev) => prev.filter((f) => f.id !== id));
    } catch {
      toast.error('Could not archive form');
    }
  };

  const handleTogglePublish = async (form: FormItem) => {
    const endpoint = form.status === 'published' ? 'unpublish' : 'publish';
    try {
      const res = await fetch(`/api/forms/${form.id}/${endpoint}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? 'Failed');
      }
      const updated = await res.json();
      setForms((prev) =>
        prev.map((f) => (f.id === form.id ? { ...f, status: updated.status } : f)),
      );
      toast.success(
        updated.status === 'published' ? 'Form published' : 'Form unpublished',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update form');
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const showTemplates = forms.length < 3;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Forms</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Build forms to capture leads, feedback, and bookings on any channel.
          </p>
        </div>
        <Button id="btn-new-form" onClick={() => setShowCreate(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New form
        </Button>
      </div>

      {/* Quick-start templates */}
      {showTemplates && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent-violet" />
            <h2 className="text-sm font-semibold text-muted-foreground">
              Quick-start templates
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {FORM_TEMPLATE_ORDER.map((slug) => {
              const tmpl = FORM_TEMPLATES[slug];
              const IconComponent = TEMPLATE_ICONS[tmpl.iconName];
              return (
                <button
                  key={slug}
                  id={`btn-template-${slug}`}
                  disabled={creating}
                  onClick={() => startFromTemplateDirectly(slug)}
                  className="group flex flex-col items-start rounded-xl border bg-card p-4 text-left shadow-xs transition-all hover:border-violet-400 hover:shadow-sm"
                >
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-accent-violet transition-colors group-hover:bg-violet-500/20">
                    <IconComponent className="h-5 w-5" />
                  </div>
                  <div className="text-sm font-semibold text-foreground">
                    {tmpl.name}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                    {tmpl.description}
                  </p>
                  <span className="mt-3 text-xs font-medium text-accent-violet opacity-0 transition-opacity group-hover:opacity-100">
                    Use template →
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Empty state */}
      {forms.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed py-16 text-center bg-card/40">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-500/10 text-accent-violet">
            <FileText className="h-6 w-6" />
          </div>
          <div>
            <p className="font-medium text-foreground">No forms created yet</p>
            <p className="mt-1 text-sm text-muted-foreground max-w-sm">
              Pick a quick-start template above or build a custom form from scratch.
            </p>
          </div>
          <Button id="btn-create-first-form" onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create custom form
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {forms.map((form) => (
            <div
              key={form.id}
              className="group relative flex flex-col gap-3 rounded-lg border bg-card p-5 shadow-xs transition-shadow hover:shadow-md"
            >
              {/* Kind + status badges */}
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    'text-xs',
                    form.kind === 'booking' && 'border-violet-300 text-accent-violet',
                  )}
                >
                  {form.kind === 'booking' ? 'Booking form' : 'Form'}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    'text-xs',
                    form.status === 'published'
                      ? 'border-green-300 text-accent-green'
                      : 'border-gray-300 text-muted-foreground',
                  )}
                >
                  {form.status === 'published' ? (
                    <CheckCircle className="mr-1 h-3 w-3" />
                  ) : (
                    <Clock className="mr-1 h-3 w-3" />
                  )}
                  {form.status === 'published' ? 'Published' : 'Draft'}
                </Badge>
              </div>

              {/* Name */}
              <h3
                className="cursor-pointer font-medium hover:underline"
                onClick={() => router.push(`/forms/${form.id}`)}
              >
                {form.name}
              </h3>

              {/* Description if present */}
              {form.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {form.description}
                </p>
              )}

              {/* Stats */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-auto">
                <span className="flex items-center gap-1">
                  <BarChart2 className="h-3 w-3" />
                  {form.submission_count}{' '}
                  {form.submission_count === 1 ? 'submission' : 'submissions'}
                </span>
                {form.status === 'published' && (
                  <a
                    href={form.public_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Globe className="h-3 w-3" />
                    View form
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>

              {/* Actions */}
              <div className="absolute right-3 top-3">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    id={`btn-form-actions-${form.id}`}
                    aria-label="Form actions"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-foreground group-hover:opacity-100"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => router.push(`/forms/${form.id}`)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => router.push(`/forms/${form.id}/submissions`)}
                    >
                      <BarChart2 className="mr-2 h-4 w-4" />
                      Submissions
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleTogglePublish(form)}>
                      {form.status === 'published' ? (
                        <>
                          <Clock className="mr-2 h-4 w-4" />
                          Unpublish
                        </>
                      ) : (
                        <>
                          <Globe className="mr-2 h-4 w-4" />
                          Publish
                        </>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDuplicate(form.id)}>
                      <Copy className="mr-2 h-4 w-4" />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => handleArchive(form.id)}
                    >
                      <Archive className="mr-2 h-4 w-4" />
                      Archive
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create form dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create new form</DialogTitle>
            <DialogDescription>
              Start with a blank canvas or pick a pre-built sample template.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* Template selector cards */}
            <div className="flex flex-col gap-2">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Select Template
              </Label>
              <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto p-1">
                {/* Blank form option */}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTemplate('blank');
                    if (!newName) setNewName('');
                  }}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border p-3 text-left transition-all',
                    selectedTemplate === 'blank'
                      ? 'border-violet-500 bg-violet-500/10'
                      : 'hover:bg-muted/50',
                  )}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <LayoutTemplate className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-sm font-medium">Blank Form</div>
                    <div className="text-xs text-muted-foreground">Start from scratch with zero pre-made fields.</div>
                  </div>
                </button>

                {/* Pre-made templates */}
                {FORM_TEMPLATE_ORDER.map((slug) => {
                  const tmpl = FORM_TEMPLATES[slug];
                  const Icon = TEMPLATE_ICONS[tmpl.iconName];
                  const isSelected = selectedTemplate === slug;
                  return (
                    <button
                      key={slug}
                      type="button"
                      onClick={() => {
                        setSelectedTemplate(slug);
                        setNewName(tmpl.name);
                      }}
                      className={cn(
                        'flex items-start gap-3 rounded-lg border p-3 text-left transition-all',
                        isSelected
                          ? 'border-violet-500 bg-violet-500/10'
                          : 'hover:bg-muted/50',
                      )}
                    >
                      <div
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-accent-violet',
                          isSelected ? 'bg-violet-500/20' : 'bg-violet-500/10',
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">{tmpl.name}</div>
                        <div className="text-xs text-muted-foreground line-clamp-2">
                          {tmpl.fields.length} fields • {tmpl.description}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Form Name input */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="form-name">Form name</Label>
              <Input
                id="form-name"
                placeholder={
                  selectedTemplate !== 'blank'
                    ? FORM_TEMPLATES[selectedTemplate].name
                    : 'e.g. Lead capture, Support request'
                }
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              id="btn-confirm-create-form"
              disabled={(!newName.trim() && selectedTemplate === 'blank') || creating}
              onClick={handleCreate}
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {selectedTemplate === 'blank' ? 'Create Blank Form' : 'Use Template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
