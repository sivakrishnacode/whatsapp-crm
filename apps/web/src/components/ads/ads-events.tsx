'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Loader2, Target } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import type { AdsPixel, AdsSetupStatus } from '@/lib/ads/types';

/**
 * Ads Manager → Events.
 *
 * The Meta Pixel a website ad optimises against. Read-only on purpose: a
 * pixel is created and installed in Meta Business Settings and on the
 * customer's own site, and there is nothing useful this app can do that
 * Meta's own interface does not do better.
 *
 * What it does add is the connection: which pixel THIS workspace's
 * conversion-optimised ads will use, and whether it has ever fired — the
 * two facts a user needs before choosing a conversion goal in the wizard
 * and then wondering why delivery is poor.
 */
export function AdsEvents() {
  const [pixels, setPixels] = useState<AdsPixel[] | null>(null);
  const [setup, setSetup] = useState<AdsSetupStatus | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [pixelRes, statusRes] = await Promise.all([
          fetch('/api/ads/pixels', { cache: 'no-store' }),
          fetch('/api/ads/status', { cache: 'no-store' }),
        ]);

        if (pixelRes.ok) {
          const json = (await pixelRes.json()) as { data: AdsPixel[] };
          setPixels(json.data);
        } else {
          setPixels([]);
        }

        if (statusRes.ok) {
          setSetup((await statusRes.json()) as AdsSetupStatus);
        }
      } catch {
        toast.error('Could not load pixel information.');
        setPixels([]);
      }
    })();
  }, []);

  const selectedPixelId = setup?.pixel?.id ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Events
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The Meta Pixel your website ads optimise against. Only needed if you
          want an ad optimised for purchases or sign-ups rather than clicks.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            Pixels on this ad account
          </h2>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href="/ads/setup" />}
          >
            Change selection
          </Button>
        </header>

        {pixels === null ? (
          <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading pixels…
          </div>
        ) : pixels.length === 0 ? (
          <div className="p-8 text-center">
            <Target className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              No pixel on this ad account yet.
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
              A pixel is created in Meta Events Manager and installed on your
              website. Without one you can still run every ad type — you just
              cannot optimise for on-site conversions.
            </p>
            <a
              href="https://business.facebook.com/events_manager"
              target="_blank"
              rel="noreferrer noopener"
              className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary underline"
            >
              Open Meta Events Manager
              <ExternalLink className="size-3" />
            </a>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {pixels.map((pixel) => (
              <li
                key={pixel.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {pixel.name}
                    {pixel.id === selectedPixelId ? (
                      <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-medium text-primary">
                        In use
                      </span>
                    ) : null}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {pixel.id}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {pixel.lastFiredAt ? (
                    <>
                      Last event{' '}
                      {new Date(pixel.lastFiredAt).toLocaleDateString()}
                    </>
                  ) : (
                    // The honest reading: an installed-but-silent pixel is
                    // the usual cause of a conversion campaign that will not
                    // deliver, and Meta gives no warning about it.
                    <span className="text-amber-600 dark:text-amber-500">
                      Never fired — check the install
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">
          Conversions inside WhatsApp
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          A pixel only sees your website. For Click-to-WhatsApp ads, the
          conversion happens in a chat — so attribution comes from this CRM
          instead, on the{' '}
          <Link href="/ads/leads" className="underline">
            Leads
          </Link>{' '}
          page, which joins ad spend to the contacts and deals it produced.
        </p>
      </section>
    </div>
  );
}
