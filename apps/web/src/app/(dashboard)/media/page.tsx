'use client';

/**
 * The media library's own screen.
 *
 * Mounts the same `MediaLibrary` the pickers do, in manager mode
 * (no `onPick`, so a click selects rather than chooses). One component
 * for both is what stops the page from listing files the picker cannot
 * see — the drift that makes a library untrustworthy.
 */

import { MediaLibrary } from '@/components/media/media-library';

export default function MediaPage() {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col px-6 py-6">
      <header className="mb-4">
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          Media
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Upload once and reuse it anywhere — flows, broadcasts, templates and
          the inbox all pick from here.
        </p>
      </header>
      <MediaLibrary className="min-h-0 flex-1" />
    </div>
  );
}
