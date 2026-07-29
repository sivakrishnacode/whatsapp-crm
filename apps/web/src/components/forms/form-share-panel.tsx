'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Check, Code2, Link2, QrCode, ExternalLink } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

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
    <div className="max-w-xl">
      {!isPublished && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Publish this form before sharing — a draft URL is not accessible to visitors.
        </div>
      )}

      <Tabs defaultValue="link">
        <TabsList className="mb-4">
          <TabsTrigger value="link">
            <Link2 className="mr-2 h-4 w-4" />
            Link
          </TabsTrigger>
          <TabsTrigger value="embed">
            <Code2 className="mr-2 h-4 w-4" />
            Embed
          </TabsTrigger>
          <TabsTrigger value="qr">
            <QrCode className="mr-2 h-4 w-4" />
            QR
          </TabsTrigger>
        </TabsList>

        {/* Link */}
        <TabsContent value="link" className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Share this link on any channel, email, or social media.
            </p>
            <div className="flex gap-2">
              <Input
                id="form-share-link"
                readOnly
                value={form.public_url}
                className="font-mono text-xs"
              />
              <Button
                id="btn-copy-link"
                variant="outline"
                size="icon"
                onClick={() => copy(form.public_url, 'link')}
              >
                {copied === 'link' ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
              <a
                id="btn-open-link"
                href={form.public_url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline', size: 'icon' }))}
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Send via automation</p>
            <p className="text-xs text-muted-foreground">
              Use the <Badge variant="outline" className="text-xs">Send form</Badge> automation step to send this form link automatically.
            </p>
          </div>
        </TabsContent>

        {/* Embed */}
        <TabsContent value="embed" className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Paste this snippet into any HTML page to embed the form.
          </p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg bg-muted px-4 py-3 text-xs leading-relaxed">
              {embedSnippet}
            </pre>
            <Button
              id="btn-copy-embed"
              variant="outline"
              size="sm"
              className="absolute right-2 top-2"
              onClick={() => copy(embedSnippet, 'embed')}
            >
              {copied === 'embed' ? (
                <Check className="mr-1 h-3 w-3 text-green-500" />
              ) : (
                <Copy className="mr-1 h-3 w-3" />
              )}
              Copy
            </Button>
          </div>
        </TabsContent>

        {/* QR */}
        <TabsContent value="qr" className="flex flex-col items-start gap-4">
          <p className="text-sm text-muted-foreground">
            Use this QR code in print materials, flyers, or receipts.
          </p>
          {/* Rendered via a free QR API — no dependency needed */}
          {isPublished ? (
            <div className="flex flex-col gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(form.public_url)}`}
                alt="QR code"
                className="rounded-lg border"
                width={200}
                height={200}
              />
              <a
                id="btn-download-qr"
                href={`https://api.qrserver.com/v1/create-qr-code/?size=400x400&format=png&data=${encodeURIComponent(form.public_url)}`}
                download={`${form.slug}-qr.png`}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                Download QR (400×400)
              </a>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Publish the form to generate a QR code
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
