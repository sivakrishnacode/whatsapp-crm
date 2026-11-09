'use client';

import { useState } from 'react';

/**
 * A temporary password, shown once. It exists only in this action result —
 * the database holds the hash — so leaving the page loses it for good, and
 * the box says so. Copying uses the Clipboard API; selecting the text works
 * where that is unavailable.
 */
export function SecretReveal({
  secret,
  owner,
}: {
  secret: string;
  owner?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="border-warn-fg/30 bg-warn-soft rounded-xl border px-3.5 py-3">
      <p className="text-warn-fg text-xs font-semibold">
        Temporary password{owner ? ` for ${owner}` : ''} — shown once
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="bg-surface text-ink rounded-md px-2.5 py-1.5 font-mono text-sm tracking-wide select-all">
          {secret}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
          className="border-ring bg-surface text-ink hover:bg-surface-2 rounded-lg border px-2.5 py-1 text-xs font-semibold"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-warn-fg mt-2 text-xs leading-relaxed">
        Hand it over in person or through a channel you trust, not in a ticket
        or chat that is logged. It is not stored anywhere readable — if it is
        lost, reset the password again. They should change it from their account
        menu after signing in.
      </p>
    </div>
  );
}
