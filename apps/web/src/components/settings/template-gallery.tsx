'use client';

import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  FileText,
  Image as ImageIcon,
  LayoutTemplate,
  MapPin,
  Play,
  Rows3,
  Type,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TemplateFormData, TemplateTypeOption } from '@/lib/whatsapp/template-form';
import {
  filterLibrary,
  LIBRARY_TYPE_FILTERS,
  type LibraryTemplate,
} from '@/lib/whatsapp/template-library';
import { TemplatePreview } from './template-preview';

const TYPE_ICONS: Record<string, typeof Type> = {
  NONE: Type,
  TEXT: Type,
  IMAGE: ImageIcon,
  VIDEO: Play,
  FILE: FileText,
  LOCATION: MapPin,
  CAROUSEL: Rows3,
};

const TYPE_LABELS: Record<string, string> = {
  NONE: 'text',
  TEXT: 'text header',
  IMAGE: 'image',
  VIDEO: 'video',
  FILE: 'file',
  LOCATION: 'location',
  CAROUSEL: 'carousel',
};

interface TemplateGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Hands the chosen starter's form to the editor. Deliberately named
   * "use", not "submit": picking a starter only fills the builder, and
   * nothing reaches Meta until the user reviews it and submits.
   */
  onUse: (form: TemplateFormData) => void;
}

export function TemplateGallery({
  open,
  onOpenChange,
  onUse,
}: TemplateGalleryProps) {
  const [category, setCategory] = useState<LibraryTemplate['category']>('Marketing');
  const [typeFilter, setTypeFilter] = useState<'ALL' | TemplateTypeOption>('ALL');
  // Non-null while previewing one starter full-size, which replaces the
  // grid rather than opening a second dialog on top of it.
  const [previewing, setPreviewing] = useState<LibraryTemplate | null>(null);

  const results = useMemo(
    () => filterLibrary(category, typeFilter),
    [category, typeFilter],
  );

  function reset() {
    setPreviewing(null);
    setTypeFilter('ALL');
    setCategory('Marketing');
  }

  function use(entry: LibraryTemplate) {
    onUse(entry.form);
    onOpenChange(false);
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-4xl">
        {previewing ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {previewing.title}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {previewing.description}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="border border-border bg-muted text-[10px] uppercase text-muted-foreground">
                    {previewing.category}
                  </Badge>
                  <Badge className="border border-border bg-muted text-[10px] uppercase text-muted-foreground">
                    {TYPE_LABELS[previewing.type]}
                  </Badge>
                </div>
                <div className="rounded-md border border-border bg-muted/40 p-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    Sample values
                  </p>
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {previewing.form.body_samples.length === 0 ? (
                      <li>No variables — the body sends as written.</li>
                    ) : (
                      previewing.form.body_samples.map((s, i) => (
                        <li key={i}>
                          <code className="text-foreground">{`{{${i + 1}}}`}</code>{' '}
                          → {s}
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                {previewing.needsMedia && (
                  <p className="rounded-md border border-warning/30 bg-warning-surface px-3 py-2 text-xs text-warning">
                    You&apos;ll need to add your own{' '}
                    {TYPE_LABELS[previewing.type]} before submitting — we
                    can&apos;t ship media with a starter.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Everything here lands in the editor for you to change.
                  Nothing is sent to Meta until you submit it.
                </p>
              </div>

              <TemplatePreview form={previewing.form} />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setPreviewing(null)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
              <Button
                onClick={() => use(previewing)}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Use this template
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <LayoutTemplate className="size-4 text-primary" />
                Start from a pre-built template
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Each one is already Meta-valid — variables, samples,
                footers and buttons included. Picking one fills the editor
                so you can edit it before submitting.
              </DialogDescription>
            </DialogHeader>

            <Tabs
              value={category}
              onValueChange={(val) => {
                if (!val) return;
                setCategory(val as LibraryTemplate['category']);
              }}
            >
              <TabsList className="border-b border-border bg-muted/50">
                <TabsTrigger
                  value="Marketing"
                  className="text-muted-foreground data-active:bg-muted data-active:text-primary"
                >
                  Marketing
                </TabsTrigger>
                <TabsTrigger
                  value="Utility"
                  className="text-muted-foreground data-active:bg-muted data-active:text-primary"
                >
                  Utility
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
              {/* Type rail. Counts are per-category, so switching tabs
                  can empty a filter — the grid says so rather than
                  silently showing nothing. */}
              <div className="flex flex-row gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
                {LIBRARY_TYPE_FILTERS.map((f) => {
                  const Icon = f.value === 'ALL' ? LayoutTemplate : TYPE_ICONS[f.value];
                  const active = typeFilter === f.value;
                  return (
                    <button
                      key={f.value}
                      type="button"
                      onClick={() => setTypeFilter(f.value)}
                      className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                        active
                          ? 'bg-primary/15 text-primary'
                          : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {Icon && <Icon className="size-3.5 shrink-0" />}
                      {f.label}
                    </button>
                  );
                })}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {results.length === 0 ? (
                  <p className="col-span-full rounded-md border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                    No {category.toLowerCase()} starters of this type yet.
                  </p>
                ) : (
                  results.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex flex-col rounded-lg border border-border bg-background/50 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-popover-foreground">
                          {entry.title}
                        </p>
                        <Badge className="shrink-0 border border-border bg-muted text-[10px] uppercase text-muted-foreground">
                          {TYPE_LABELS[entry.type]}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-3 flex-1 text-xs text-muted-foreground">
                        {entry.form.body_text}
                      </p>
                      {entry.needsMedia && (
                        <p className="mt-1.5 text-[10px] uppercase tracking-wide text-warning">
                          Needs your media
                        </p>
                      )}
                      <div className="mt-3 flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPreviewing(entry)}
                          className="flex-1 border-border text-muted-foreground hover:bg-muted"
                        >
                          Preview
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => use(entry)}
                          className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          Use
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
