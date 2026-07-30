'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { MessageTemplate } from '@/types';
import { buildTemplateApiExample } from '@/lib/whatsapp/template-api-example';

interface TemplateApiDialogProps {
  template: MessageTemplate | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Shows the request body that sends this template through the public v1
 * API. Generated from the template row, so the parameter shape is always
 * the one this specific template needs — media header, location pin,
 * button suffixes and carousel cards each change it.
 */
export function TemplateApiDialog({
  template,
  onOpenChange,
}: TemplateApiDialogProps) {
  const [tab, setTab] = useState<'curl' | 'json'>('curl');
  const [copied, setCopied] = useState(false);

  const example = useMemo(
    () =>
      template
        ? buildTemplateApiExample(
            template,
            typeof window === 'undefined' ? undefined : window.location.origin,
          )
        : null,
    [template],
  );

  const snippet = !example
    ? ''
    : tab === 'curl'
      ? example.curl
      : JSON.stringify(example.body, null, 2);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy — select the text and copy manually.');
    }
  }

  return (
    <Dialog open={template !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Send &ldquo;{template?.name}&rdquo; via API
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            The request body for this template, with its own sample values
            filled in.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <Tabs
            value={tab}
            onValueChange={(v) => {
              if (v) setTab(v as 'curl' | 'json');
            }}
          >
            <TabsList className="bg-muted/50">
              <TabsTrigger
                value="curl"
                className="text-muted-foreground data-active:bg-muted data-active:text-primary"
              >
                curl
              </TabsTrigger>
              <TabsTrigger
                value="json"
                className="text-muted-foreground data-active:bg-muted data-active:text-primary"
              >
                JSON body
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="outline"
            size="sm"
            onClick={copy}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-foreground">
          <code>{snippet}</code>
        </pre>

        {example && example.notes.length > 0 && (
          <ul className="space-y-1.5">
            {example.notes.map((note) => (
              <li
                key={note}
                className="flex items-start gap-2 text-[11px] text-muted-foreground"
              >
                <Info className="mt-0.5 size-3 shrink-0 text-primary" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
