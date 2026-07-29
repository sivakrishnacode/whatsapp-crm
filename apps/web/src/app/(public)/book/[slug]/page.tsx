import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CalendarClock } from 'lucide-react';

import { HostedBookingForm } from '@/components/forms/hosted-booking-form';
import type { PublicForm } from '@/components/forms/form-renderer';

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Where the SSR fetch for a public page should go.
 *
 * Server-only, and deliberately NOT `NEXT_PUBLIC_API_URL`.
 *
 *   These pages render on the server, inside the container, so the right
 *   address is the internal one (`http://api:8001`) — it skips the public
 *   internet, TLS and nginx for a call that never leaves the host.
 *
 *   A `NEXT_PUBLIC_` variable is INLINED INTO CLIENT BUNDLES at build time
 *   wherever it is referenced. Using one for an internal hostname is a
 *   footgun waiting for the first client component that reads it: it would
 *   ship `http://api:8001` to a browser, which cannot resolve it. Reading a
 *   server-only var makes that mistake impossible rather than merely
 *   avoided.
 *
 *   `NEST_API_URL` is the same variable the rewrite in next.config.ts uses,
 *   so there is one answer to "where is the API" rather than two that can
 *   disagree.
 */
function apiBase(): string {
  return (
    process.env.NEST_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    'http://localhost:8001'
  );
}

async function loadForm(slug: string): Promise<PublicForm | null> {
  try {
    const res = await fetch(`${apiBase()}/public/forms/${slug}`, {
      // The form DEFINITION is cacheable; its availability is not, and is
      // fetched client-side on render. Caching the questions is free; caching
      // the times would offer slots that are already gone.
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicForm;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const form = await loadForm(slug);
  if (!form) return {};
  return {
    title: form.name,
    description: form.description ?? `Book ${form.name}`,
  };
}

/**
 * The public booking page.
 *
 * This replaced a static mockup: it prettified the slug into a title and
 * rendered a hardcoded "30 Minutes / Web Conference" panel and a fake slot grid
 * with no fetches at all. It looked finished and booked nothing — and it
 * promised "a confirmation email and calendar invitation will be sent
 * automatically", which nothing implemented.
 *
 * A booking form is an ordinary form that happens to carry an
 * `appointment_slot` field, so this page is the hosted form page with a slot
 * loader wired in. No separate booking model, no appointment types, no second
 * renderer to keep in step. Duration, location and confirmation wording are
 * whatever the form's own fields and settings say, rather than copy baked into
 * a page.
 */
export default async function PublicBookingPage({ params }: Props) {
  const { slug } = await params;
  const form = await loadForm(slug);

  if (!form) notFound();

  const takesBookings = form.fields.some((f) => f.type === 'appointment_slot');

  return (
    <div className="min-h-screen bg-slate-50 py-8 text-slate-900 transition-colors md:py-16 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-2xl px-4">
        <div className="overflow-hidden rounded-2xl border border-border/80 bg-card text-card-foreground shadow-2xl shadow-slate-900/10 transition-all dark:shadow-none">
          <div className="bg-gradient-to-r from-violet-600 via-indigo-600 to-purple-600 px-8 py-10 text-white shadow-inner">
            <div className="flex items-center gap-2 text-violet-100">
              <CalendarClock className="h-4 w-4" />
              <span className="text-xs font-medium tracking-wide uppercase">
                Book a time
              </span>
            </div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
              {form.name}
            </h1>
            {form.description && (
              <p className="mt-2 text-sm leading-relaxed text-violet-100 md:text-base">
                {form.description}
              </p>
            )}
          </div>

          <div className="px-6 py-8 sm:px-10">
            {takesBookings ? (
              <HostedBookingForm form={form} slug={slug} />
            ) : (
              // Reached when a /book/ link is shared for a form with no slot
              // field. Saying so beats rendering a booking-branded page that
              // quietly behaves like a contact form.
              <div className="py-8 text-center">
                <p className="text-sm font-medium text-foreground">
                  This form isn’t set up for bookings.
                </p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                  It has no time picker, so there is nothing to book. You can
                  still fill it in at its own link.
                </p>
                <a
                  href={`/f/${slug}`}
                  className="mt-4 inline-block text-xs underline underline-offset-2"
                >
                  Open the form
                </a>
              </div>
            )}
          </div>
        </div>

        <p className="mt-8 text-center text-xs font-medium text-muted-foreground/70">
          Powered by{' '}
          <span className="font-semibold text-foreground/80">Converse360</span>
        </p>
      </div>
    </div>
  );
}
