'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ImagePlus, Loader2, Plus, Sparkles, Video } from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AdMediaItem, AdTypeInfo, MetaLeadFormSummary } from '@/lib/ads/types';
import { LIMITS, isConversionGoal, type WizardState } from './wizard-state';

/**
 * Step 4 — copy, media, CTA.
 *
 * Character counters are always visible rather than appearing on overflow:
 * the headline limit is 40, which is short enough that people plan around
 * it, and Meta's rejection for an over-long one is a generic "Invalid
 * parameter" arriving after the campaign already exists.
 *
 * "Generate creatives with AI" from the reference is deliberately absent —
 * see docs/meta-ads-manager.md §12. It needs an image-generation provider,
 * a per-account quota ledger and a moderation story, none of which this
 * app has.
 */
export function CreativeStep({
  state,
  patch,
  selectedType,
  pixelEvents,
  pixelSelected,
}: {
  state: WizardState;
  patch: (next: Partial<WizardState>) => void;
  selectedType: AdTypeInfo | null;
  pixelEvents: Array<{ value: string; label: string }>;
  pixelSelected: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [library, setLibrary] = useState<AdMediaItem[] | null>(null);
  const [leadForms, setLeadForms] = useState<MetaLeadFormSummary[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/ads/media', { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as { data: AdMediaItem[] };
          setLibrary(json.data);
        }
      } catch {
        setLibrary([]);
      }
    })();
  }, []);

  // Lead forms only matter for the one type that uses them.
  useEffect(() => {
    if (!selectedType?.needsLeadForm) return;
    void (async () => {
      try {
        const res = await fetch('/api/ads/lead-forms', { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as { data: MetaLeadFormSummary[] };
          setLeadForms(json.data);
        }
      } catch {
        setLeadForms([]);
      }
    })();
  }, [selectedType?.needsLeadForm]);

  async function upload(file: File) {
    setUploading(true);
    try {
      const dataBase64 = await fileToBase64(file);

      const res = await fetch('/api/ads/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          dataBase64,
        }),
      });

      const body = (await res.json().catch(() => null)) as
        | {
            message?: string | string[];
            kind?: string;
            imageHash?: string;
            videoId?: string;
            url?: string | null;
            ready?: boolean;
          }
        | null;

      if (!res.ok) {
        const message = Array.isArray(body?.message)
          ? body.message.join(', ')
          : body?.message;
        throw new Error(message ?? 'Meta rejected the upload.');
      }

      if (body?.imageHash) {
        patch({
          imageHash: body.imageHash,
          videoId: '',
          videoThumbnailUrl: '',
          // Local object URL: Meta's own `url` is often absent right after
          // upload, and the preview should not wait for it.
          mediaPreviewUrl: URL.createObjectURL(file),
        });
        toast.success('Image ready.');
      } else if (body?.videoId) {
        patch({
          videoId: body.videoId,
          imageHash: '',
          mediaPreviewUrl: null,
        });
        // Meta transcodes asynchronously; publishing against an
        // unprocessed video fails at the creative step.
        toast.info('Video uploaded — Meta is processing it.');
        void pollVideo(body.videoId);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function pollVideo(videoId: string) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        const res = await fetch(`/api/ads/media/video/${videoId}`, {
          cache: 'no-store',
        });
        if (!res.ok) continue;
        const status = (await res.json()) as {
          ready: boolean;
          thumbnailUrl: string | null;
        };
        if (status.ready) {
          patch({
            videoThumbnailUrl: status.thumbnailUrl ?? '',
            mediaPreviewUrl: status.thumbnailUrl,
          });
          toast.success('Video processed and ready to publish.');
          return;
        }
      } catch {
        // Keep polling — a transient failure is not a processing failure.
      }
    }
    toast.warning(
      'Meta is still processing the video. You can publish once it finishes.',
    );
  }

  const callToActions = selectedType?.callToActions ?? [];

  return (
    <div className="space-y-5">
      <label className="block">
        <span className="mb-1.5 flex items-baseline justify-between text-xs font-medium text-foreground">
          Ad name
          <Counter value={state.adName.length} max={LIMITS.adName} />
        </span>
        <Input
          value={state.adName}
          onChange={(e) => patch({ adName: e.target.value })}
          placeholder={state.campaignName || 'Monsoon sale — square image'}
          maxLength={LIMITS.adName}
        />
      </label>

      <label className="block">
        <span className="mb-1.5 flex items-baseline justify-between text-xs font-medium text-foreground">
          Primary text
          <Counter
            value={state.primaryText.length}
            max={LIMITS.primaryText}
            /* Facebook collapses past ~125 characters, which matters more
               than the hard limit — the preview shows where. */
            warnAt={125}
          />
        </span>
        <Textarea
          value={state.primaryText}
          onChange={(e) => patch({ primaryText: e.target.value })}
          placeholder="Monsoon sale is live. Message us for today's price list."
          rows={4}
          maxLength={LIMITS.primaryText}
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          Facebook hides anything past about 125 characters behind
          &ldquo;See more&rdquo;.
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 flex items-baseline justify-between text-xs font-medium text-foreground">
            Headline
            <Counter value={state.headline.length} max={LIMITS.headline} />
          </span>
          <Input
            value={state.headline}
            onChange={(e) => patch({ headline: e.target.value })}
            placeholder="Up to 40% off"
            maxLength={LIMITS.headline}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 flex items-baseline justify-between text-xs font-medium text-foreground">
            Description
            <Counter value={state.description.length} max={LIMITS.description} />
          </span>
          <Input
            value={state.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="Ends Sunday"
            maxLength={LIMITS.description}
          />
        </label>
      </div>

      {/* Destination URL — only for the types that use one. */}
      {selectedType?.needsLink ? (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Web address
          </span>
          <Input
            value={state.link}
            onChange={(e) => patch({ link: e.target.value })}
            placeholder="https://example.com/monsoon-sale"
            inputMode="url"
          />
        </label>
      ) : null}

      {/* Conversion event — only when the chosen goal actually optimises for
          one. Asked explicitly rather than defaulted, because bidding for
          PURCHASE on a sign-up campaign spends the budget on the wrong
          action and looks like poor delivery rather than a misconfiguration. */}
      {isConversionGoal(state.optimizationGoal) ? (
        <div>
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Conversion event
          </span>
          <Select
            value={state.conversionEvent || null}
            onValueChange={(next) => {
              if (typeof next === 'string') patch({ conversionEvent: next });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose the event to optimise for" />
            </SelectTrigger>
            <SelectContent>
              {pixelEvents.map((event) => (
                <SelectItem key={event.value} value={event.value}>
                  {event.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="mt-1 block text-xs text-muted-foreground">
            Meta bids for people likely to trigger this event on your site. It
            must be an event your pixel actually reports —{' '}
            <Link href="/ads/events" className="underline">
              check which have fired
            </Link>
            .
          </span>
          {!pixelSelected ? (
            <span className="mt-1 block text-xs text-accent-amber">
              No pixel is selected for this workspace, so this goal cannot be
              used. Pick one in Setup, or choose a click-based goal in step 1.
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Lead form — only for the one type that needs it. */}
      {selectedType?.needsLeadForm ? (
        <div>
          <span className="mb-1.5 flex items-center justify-between text-xs font-medium text-foreground">
            Lead form
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href="/ads/lead-forms" />}
            >
              <Plus className="size-3" />
              Create new
            </Button>
          </span>
          <Select
            value={state.leadFormId || null}
            onValueChange={(next) => {
              if (typeof next === 'string') patch({ leadFormId: next });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a form" />
            </SelectTrigger>
            <SelectContent>
              {leadForms === null ? (
                <SelectItem value="__loading" disabled>
                  Loading…
                </SelectItem>
              ) : leadForms.length === 0 ? (
                <SelectItem value="__empty" disabled>
                  No forms yet — create one first
                </SelectItem>
              ) : (
                leadForms.map((form) => (
                  <SelectItem key={form.id} value={form.id}>
                    {form.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {/* Prefilled WhatsApp message — the biggest lever on CTWA drop-off. */}
      {selectedType?.needsWhatsApp && selectedType.id === 'click_to_whatsapp' ? (
        <label className="block">
          <span className="mb-1.5 flex items-baseline justify-between text-xs font-medium text-foreground">
            Prefilled first message
            <Counter
              value={state.whatsappWelcomeMessage.length}
              max={LIMITS.welcomeMessage}
            />
          </span>
          <Input
            value={state.whatsappWelcomeMessage}
            onChange={(e) => patch({ whatsappWelcomeMessage: e.target.value })}
            placeholder="Hi, I saw your monsoon sale ad and want the price list"
            maxLength={LIMITS.welcomeMessage}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Appears already typed in the customer&apos;s chat box. Leaving it
            empty means they have to compose something themselves, which is
            where most people give up.
          </span>
        </label>
      ) : null}

      {/* CTA */}
      {callToActions.length > 0 ? (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Button
          </span>
          <Select
            value={state.callToAction || null}
            onValueChange={(next) => {
              if (typeof next === 'string') patch({ callToAction: next });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a button" />
            </SelectTrigger>
            <SelectContent>
              {callToActions.map((cta) => (
                <SelectItem key={cta.value} value={cta.value}>
                  {cta.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}

      {/* Media */}
      <div>
        <span className="mb-1.5 block text-xs font-medium text-foreground">
          Image or video
        </span>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,video/mp4,video/quicktime"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = '';
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ImagePlus className="size-3.5" />
            )}
            Upload
          </Button>

          {state.videoId && !state.videoThumbnailUrl ? (
            <span className="flex items-center gap-1.5 text-xs text-accent-amber">
              <Loader2 className="size-3 animate-spin" />
              Meta is processing the video…
            </span>
          ) : null}
        </div>

        {/* The library — previously uploaded creatives on this ad account. */}
        {library && library.length > 0 ? (
          <div className="mt-3">
            <p className="mb-1.5 text-xs text-muted-foreground">
              Or reuse a creative
            </p>
            <div className="flex flex-wrap gap-2">
              {library.slice(0, 12).map((item) => {
                const selected =
                  (item.imageHash && item.imageHash === state.imageHash) ||
                  (item.videoId && item.videoId === state.videoId);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      patch({
                        imageHash: item.imageHash ?? '',
                        videoId: item.videoId ?? '',
                        videoThumbnailUrl: '',
                        mediaPreviewUrl: item.url,
                      })
                    }
                    className={cn(
                      'flex size-16 items-center justify-center overflow-hidden rounded-lg border transition-colors',
                      selected
                        ? 'border-primary ring-2 ring-primary/30'
                        : 'border-border hover:border-border/80',
                    )}
                    title={item.name ?? undefined}
                  >
                    {item.url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- Meta-hosted creative
                      <img
                        src={item.url}
                        alt={item.name ?? ''}
                        className="size-full object-cover"
                      />
                    ) : item.kind === 'video' ? (
                      <Video className="size-5 text-muted-foreground" />
                    ) : (
                      <ImagePlus className="size-5 text-muted-foreground" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {/* Honest note about what is missing, rather than a disabled button
          that implies it is coming next week. */}
      <p className="flex items-start gap-1.5 rounded-lg bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
        <Sparkles className="mt-0.5 size-3.5 shrink-0" />
        AI creative generation is not part of this release — it needs an
        image-generation provider and a usage budget. Upload your own image or
        video for now.
      </p>
    </div>
  );
}

function Counter({
  value,
  max,
  warnAt,
}: {
  value: number;
  max: number;
  warnAt?: number;
}) {
  const over = value > max;
  const warn = warnAt !== undefined && value > warnAt;
  return (
    <span
      className={cn(
        'text-[10px] tabular-nums',
        over
          ? 'text-destructive'
          : warn
            ? 'text-accent-amber'
            : 'text-muted-foreground',
      )}
    >
      {value}/{max}
    </span>
  );
}

/**
 * File → base64, without the data-URL prefix.
 *
 * `FileReader` rather than `Buffer`: this runs in the browser. The prefix
 * has to go because the API decodes the string with
 * `Buffer.from(..., 'base64')`, which would treat `data:image/png;base64,`
 * as payload and produce a corrupt file.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}
