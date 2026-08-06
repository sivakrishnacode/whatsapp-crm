'use client';

import { useState } from 'react';

import {
  ExternalLink,
  Globe,
  ImageIcon,
  Loader2,
  MessageCircle,
  ThumbsUp,
  Share2,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import type { AdType } from '@/lib/ads/types';

/**
 * A mock of how the ad will look in feed.
 *
 * WHY A MOCK RATHER THAN META'S REAL PREVIEW
 *   Meta has `/act_X/generatepreviews`, which returns the genuine
 *   rendering — and it is wired up in `marketing-objects.util.ts`. It is
 *   not used here because it returns an `<iframe src="facebook.com/...">`,
 *   and this app's CSP has no `frame-src` entry for facebook.com. The
 *   policy currently ships Report-Only, so an iframe would work in
 *   development and silently break the day CSP is enforced.
 *
 *   So: a mock, clearly a mock, plus a real-preview path ready to adopt
 *   once the CSP question is decided. The reference product also mocks it.
 *
 * It exists to answer one question — "is my copy the right length?" —
 * which is why the character-limited fields are rendered at their real
 * relative sizes and truncated exactly as Facebook truncates them.
 */
export function AdPreview({
  adType,
  pageName,
  primaryText,
  headline,
  description,
  callToActionLabel,
  imageUrl,
  link,
  onRequestRealPreview,
}: {
  adType: AdType;
  pageName: string | null;
  primaryText: string;
  headline: string;
  description: string;
  callToActionLabel: string | null;
  imageUrl: string | null;
  link: string | null;
  /**
   * Fetches Meta's own rendering and returns its URL, or a reason it is
   * unavailable. Omitted when the form is not complete enough to render.
   */
  onRequestRealPreview?: () => Promise<{
    url: string | null;
    unavailableReason: string | null;
  }>;
}) {
  const host = safeHost(link);
  const [loadingReal, setLoadingReal] = useState(false);

  /**
   * Open Meta's real preview in a new tab.
   *
   * A new tab rather than an iframe: `/generatepreviews` returns a
   * facebook.com iframe, and this app's CSP has no `frame-src` for it. The
   * policy is Report-Only today, so embedding would work in development and
   * break on enforcement.
   */
  async function openRealPreview() {
    if (!onRequestRealPreview) return;
    setLoadingReal(true);
    try {
      const result = await onRequestRealPreview();
      if (result.url) {
        window.open(result.url, '_blank', 'noopener,noreferrer');
      } else {
        toast.info(
          result.unavailableReason ??
            'Meta could not generate a preview for this ad yet.',
        );
      }
    } catch {
      toast.error('Could not reach Meta for a preview.');
    } finally {
      setLoadingReal(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-xs font-medium text-muted-foreground">Preview</p>
      </div>

      <div className="p-3">
        <div className="overflow-hidden rounded-lg border border-border">
          {/* Page header */}
          <div className="flex items-center gap-2.5 p-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
              {(pageName ?? 'P').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {pageName ?? 'Your page'}
              </p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                Sponsored <Globe className="size-3" />
              </p>
            </div>
          </div>

          {/* Primary text. Facebook collapses past ~125 characters behind
              a "See more", so the preview does too — it is the single most
              useful thing this mock can tell you. */}
          <div className="px-3 pb-2">
            {primaryText ? (
              <p className="text-sm whitespace-pre-wrap text-foreground">
                {primaryText.length > 125 ? (
                  <>
                    {primaryText.slice(0, 125)}
                    <span className="text-muted-foreground">
                      … See more
                    </span>
                  </>
                ) : (
                  primaryText
                )}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Your ad copy appears here
              </p>
            )}
          </div>

          {/* Media */}
          <div className="aspect-square w-full bg-muted">
            {imageUrl ? (
              /* A Meta-hosted creative URL or a local object: URL, neither
                 of which next/image can optimise. */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt=""
                className="size-full object-cover"
              />
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <ImageIcon className="size-8" />
                <span className="text-xs">Your image or video</span>
              </div>
            )}
          </div>

          {/* Headline / description / CTA strip */}
          <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/40 px-3 py-2.5">
            <div className="min-w-0">
              {host ? (
                <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                  {host}
                </p>
              ) : adType === 'lead_form' ? (
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Lead form
                </p>
              ) : null}
              <p className="truncate text-sm font-semibold text-foreground">
                {headline || 'Your headline'}
              </p>
              {description ? (
                <p className="truncate text-xs text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>

            {callToActionLabel ? (
              <span
                className={cn(
                  'shrink-0 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground',
                )}
              >
                {callToActionLabel}
              </span>
            ) : null}
          </div>

          {/* Social row — pure chrome, but its absence makes the mock read
              as a broken card rather than a Facebook post. */}
          <div className="flex items-center justify-around border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <ThumbsUp className="size-3.5" /> Like
            </span>
            <span className="flex items-center gap-1">
              <MessageCircle className="size-3.5" /> Comment
            </span>
            <span className="flex items-center gap-1">
              <Share2 className="size-3.5" /> Share
            </span>
          </div>
        </div>

        <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          An approximation of the Facebook feed placement. The real rendering
          varies by placement and device.
        </p>

        {onRequestRealPreview ? (
          <button
            type="button"
            onClick={() => void openRealPreview()}
            disabled={loadingReal}
            className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary underline disabled:opacity-60"
          >
            {loadingReal ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ExternalLink className="size-3" />
            )}
            See Meta&apos;s exact preview
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Hostname for the preview's link strip, or null for anything unparseable. */
function safeHost(link: string | null): string | null {
  if (!link) return null;
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
