import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import FormRenderer from '@/components/forms/form-renderer';
import FormSurface from '@/components/forms/form-surface';
import { HostedBookingForm } from '@/components/forms/hosted-booking-form';
import { resolveFormTheme } from '@/lib/forms/theme';

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

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  try {
    const res = await fetch(`${apiBase()}/public/forms/${slug}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return {};
    const form = await res.json();
    return {
      title: form.name,
      description: form.description ?? `Fill out ${form.name}`,
    };
  } catch {
    return {};
  }
}

export default async function HostedFormPage({ params }: Props) {
  const { slug } = await params;

  let form: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${apiBase()}/public/forms/${slug}`, {
      next: { revalidate: 60 },
    });
    if (res.ok) {
      form = await res.json();
    }
  } catch {
    // handled below
  }

  if (!form) notFound();

  const fields = (form.fields ?? []) as Array<{ type?: string }>;
  const takesBookings = fields.some((f) => f?.type === 'appointment_slot');
  const theme = resolveFormTheme(
    (form.settings as { theme?: unknown } | undefined)?.theme,
  );

  return (
    <FormSurface
      theme={theme}
      name={String(form.name)}
      description={form.description ? String(form.description) : null}
      booking={takesBookings}
    >
      {/*
        A form carrying an `appointment_slot` field needs a slot loader,
        and `HostedBookingForm` is the component that has one — plus the
        booking confirmation and the 409 slot-race message. Without it the
        time picker rendered its "no live availability" placeholder
        forever, on a PUBLISHED form, telling the visitor to wait for
        something that had already happened. /book/[slug] handles the
        mirror case, so both public routes now behave the same for the
        same form.
      */}
      {takesBookings ? (
        <HostedBookingForm form={form as never} slug={slug} />
      ) : (
        <FormRenderer form={form as never} source="hosted" slug={slug} />
      )}
    </FormSurface>
  );
}
