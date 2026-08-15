'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Copy,
  Check,
  Code2,
  Link2,
  QrCode,
  ExternalLink,
  Workflow,
  TriangleAlert,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { EditorCard, EditorScreen } from './form-editor-shell';

interface FormShareData {
  id: string;
  name: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  public_url: string;
}

interface FormSharePanelProps {
  form: FormShareData;
}

/**
 * The three ways to hand this form to someone.
 *
 * THEY WERE TABS INSIDE THE EDITOR'S TABS, AND ARE NOT ANY MORE
 *   Link, Embed and QR were a second tab bar nested under the first, which
 *   meant two levels of "which one am I looking at?" for three short blocks
 *   of content — and hid the embed snippet behind a click on a screen that
 *   was otherwise two thirds empty. Side by side they all fit, and choosing
 *   between them stops being a navigation decision.
 */
export default function FormSharePanel({ form }: FormSharePanelProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const embedSnippet = `<iframe
  src="${form.public_url}"
  width="100%"
  height="600"
  frameborder="0"
  style="border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.08)"
  title="${form.name}"
></iframe>`;

  const isPublished = form.status === 'published';

  return (
    <EditorScreen
      title="Share"
      description="Send the link, embed the form in a page of your own, or print the code."
      actions={
        <Badge
          variant="outline"
          className={cn(
            'text-xs',
            isPublished
              ? 'text-accent-green border-green-300'
              : 'text-accent-amber border-amber-300'
          )}
        >
          {isPublished ? 'Live' : 'Draft'}
        </Badge>
      }
    >
      {!isPublished && (
        <div className="border-accent-amber/30 bg-accent-amber-surface text-accent-amber mb-4 flex items-start gap-2.5 rounded-xl border p-3.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 flex-shrink-0" />
          <p>
            This form is a draft, so these links go nowhere yet. Publish it from
            the header and they start working immediately — the address does not
            change.
          </p>
        </div>
      )}

      {/*
        A twelve-column grid, so the three cards get proportional widths
        rather than equal thirds — the link is the thing people came for,
        the QR is a fixed 180px square, and the snippet wants reading room.
        The order is Link, QR, Embed for the same reason: at `lg` the first
        two share a row and the wide snippet takes its own, with no hole.
      */}
      <div className="grid gap-4 lg:grid-cols-12">
        <EditorCard
          title="Public link"
          icon={Link2}
          description="Works on any channel — WhatsApp, email, a button on your site."
          className="lg:col-span-7 2xl:col-span-5"
        >
          <div className="flex flex-wrap gap-2">
            <Input
              id="form-share-link"
              readOnly
              value={form.public_url}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <Button
              id="btn-copy-link"
              variant="outline"
              onClick={() => copy(form.public_url, 'link')}
            >
              {copied === 'link' ? (
                <Check className="text-accent-green mr-2 h-4 w-4" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              Copy link
            </Button>
            <a
              id="btn-open-link"
              href={form.public_url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Open
            </a>
          </div>

          <div className="border-border/60 bg-muted/30 flex items-start gap-2.5 rounded-lg border p-3">
            <Workflow className="text-muted-foreground mt-0.5 size-4 flex-shrink-0" />
            <p className="text-muted-foreground text-xs leading-relaxed">
              To send it automatically — after a keyword, a new contact or a
              closed deal — add the{' '}
              <Badge variant="outline" className="mx-0.5 text-xs">
                Send form
              </Badge>{' '}
              step to an automation and pick this form.
            </p>
          </div>
        </EditorCard>

        <EditorCard
          title="QR code"
          icon={QrCode}
          description="For print: flyers, receipts, a table card."
          className="lg:col-span-5 2xl:col-span-3"
          contentClassName="items-center justify-center"
        >
          {isPublished ? (
            <>
              {/* Rendered via a free QR API — no dependency needed */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(form.public_url)}`}
                alt={`QR code linking to ${form.name}`}
                className="border-border rounded-lg border bg-white p-2"
                width={180}
                height={180}
              />
              <a
                id="btn-download-qr"
                href={`https://api.qrserver.com/v1/create-qr-code/?size=400x400&format=png&data=${encodeURIComponent(form.public_url)}`}
                download={`${form.slug}-qr.png`}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' })
                )}
              >
                Download PNG (400×400)
              </a>
            </>
          ) : (
            <p className="border-border text-muted-foreground rounded-lg border border-dashed px-6 py-10 text-center text-sm">
              Publish the form to generate its QR code.
            </p>
          )}
        </EditorCard>

        <EditorCard
          title="Embed"
          icon={Code2}
          description="Paste this into any HTML page to show the form inline."
          className="lg:col-span-12 2xl:col-span-4"
        >
          <div className="relative">
            {/* `pr-24` so the snippet never runs underneath the Copy
                button that floats over its top-right corner. */}
            <pre className="border-border/60 bg-muted/40 max-h-56 overflow-auto rounded-lg border px-4 py-3 pr-24 text-xs leading-relaxed">
              {embedSnippet}
            </pre>
            <Button
              id="btn-copy-embed"
              variant="outline"
              size="sm"
              className="absolute top-2 right-2"
              onClick={() => copy(embedSnippet, 'embed')}
            >
              {copied === 'embed' ? (
                <Check className="text-accent-green mr-1 h-3 w-3" />
              ) : (
                <Copy className="mr-1 h-3 w-3" />
              )}
              Copy
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            The height is fixed at 600px — raise it for a long form, or the
            visitor scrolls inside the frame.
          </p>
        </EditorCard>
      </div>
    </EditorScreen>
  );
}
