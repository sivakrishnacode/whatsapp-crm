'use client';

/**
 * The panel's failure surface.
 *
 * The most likely error here is not a bug in a page — it is the database being
 * unreachable or `DATABASE_URL` being wrong, which is worth naming rather than
 * showing a bare "something went wrong". The message itself is not rendered:
 * a connection error can carry the connection string.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="border-ring bg-surface w-full max-w-md rounded-xl border p-5">
        <p className="text-ink text-sm font-semibold">
          This page didn&apos;t load
        </p>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          Usually the database: check that the panel&apos;s{' '}
          <code className="text-ink-2">DATABASE_URL</code> is set and that
          Postgres is reachable from here. The full error is in the server logs.
        </p>
        <button
          type="button"
          onClick={reset}
          className="bg-series-1 mt-4 rounded-lg px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
