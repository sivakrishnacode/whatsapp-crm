'use client';

import { FilePlus2, LayoutTemplate } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface TemplateSourceChooserProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScratch: () => void;
  onLibrary: () => void;
}

/**
 * First step of "New Template": blank editor, or start from a pre-built
 * one. Split out so the builder dialog itself never has to render two
 * modes, and so the library stays discoverable — buried behind a link
 * inside the editor, nobody would find it.
 */
export function TemplateSourceChooser({
  open,
  onOpenChange,
  onScratch,
  onLibrary,
}: TemplateSourceChooserProps) {
  const options = [
    {
      icon: FilePlus2,
      title: 'Start from scratch',
      description: 'A blank template you build field by field.',
      onClick: onScratch,
    },
    {
      icon: LayoutTemplate,
      title: 'Use a template',
      description:
        'Pick from pre-built, Meta-valid templates and edit before submitting.',
      onClick: onLibrary,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Create new template
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Both routes end in the same editor — this only decides what it
            starts with.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2 sm:grid-cols-2">
          {options.map((opt) => (
            <button
              key={opt.title}
              type="button"
              onClick={opt.onClick}
              className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/50"
            >
              <opt.icon className="size-5 text-primary" />
              <span className="font-medium text-popover-foreground">
                {opt.title}
              </span>
              <span className="text-xs text-muted-foreground">
                {opt.description}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
