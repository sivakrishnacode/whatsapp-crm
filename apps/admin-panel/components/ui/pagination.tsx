import Link from 'next/link';

/**
 * Page links that carry the active filter forward — a "next page" that quietly
 * drops the search term is worse than no pagination.
 */
export function Pagination({
  basePath,
  page,
  pageCount,
  total,
  perPage,
  params,
}: {
  basePath: string;
  page: number;
  pageCount: number;
  total: number;
  perPage: number;
  params: Record<string, string | undefined>;
}) {
  const href = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    if (target > 1) search.set('page', String(target));
    const query = search.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  const first = total === 0 ? 0 : (page - 1) * perPage + 1;
  const last = Math.min(page * perPage, total);

  return (
    <nav
      aria-label="Pagination"
      className="border-line flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3"
    >
      <p className="text-muted text-xs">
        {total === 0 ? 'No results' : `${first}–${last} of ${total}`}
      </p>

      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={href(page - 1)}
            className="border-ring text-ink hover:bg-surface-2 rounded-lg border px-3 py-1.5 text-xs"
          >
            Previous
          </Link>
        ) : (
          <span className="text-muted border-ring rounded-lg border px-3 py-1.5 text-xs opacity-50">
            Previous
          </span>
        )}

        <span className="text-muted text-xs">
          Page {page} of {pageCount}
        </span>

        {page < pageCount ? (
          <Link
            href={href(page + 1)}
            className="border-ring text-ink hover:bg-surface-2 rounded-lg border px-3 py-1.5 text-xs"
          >
            Next
          </Link>
        ) : (
          <span className="text-muted border-ring rounded-lg border px-3 py-1.5 text-xs opacity-50">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
