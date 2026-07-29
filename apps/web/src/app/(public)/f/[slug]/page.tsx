import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import FormRenderer from '@/components/forms/form-renderer';

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

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 py-8 md:py-16 transition-colors">
      <div className="mx-auto max-w-2xl px-4">
        <div className="overflow-hidden rounded-2xl bg-card border border-border/80 text-card-foreground shadow-2xl shadow-slate-900/10 dark:shadow-none transition-all">
          {/* Header */}
          <div className="bg-gradient-to-r from-violet-600 via-indigo-600 to-purple-600 px-8 py-10 text-white shadow-inner">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{String(form.name)}</h1>
            {Boolean(form.description) && (
              <p className="mt-2 text-violet-100 text-sm md:text-base leading-relaxed">
                {String(form.description)}
              </p>
            )}
          </div>

          {/* Body */}
          <div className="px-6 py-8 sm:px-10">
            <FormRenderer
              form={form as never}
              source="hosted"
              slug={slug}
            />
          </div>
        </div>

        {/* Branding */}
        <p className="mt-8 text-center text-xs font-medium text-muted-foreground/70">
          Powered by <span className="font-semibold text-foreground/80">WaCRM</span>
        </p>
      </div>
    </div>
  );
}
