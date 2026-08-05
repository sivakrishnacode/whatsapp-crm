import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="text-center">
        <p className="text-ink text-sm font-semibold">Not found</p>
        <p className="text-muted mt-2 text-sm">
          That subscriber, plan or page doesn&apos;t exist.
        </p>
        <Link
          href="/"
          className="text-ink-2 hover:text-ink mt-4 inline-block text-sm underline underline-offset-2"
        >
          Back to the overview
        </Link>
      </div>
    </div>
  );
}
