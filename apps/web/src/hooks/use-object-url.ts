'use client';

import { useEffect, useMemo } from 'react';

/**
 * Blob URL for a File that hasn't been uploaded yet, revoked when the
 * file changes or the component unmounts.
 *
 * Template media is deliberately NOT uploaded at pick time — see
 * `uploadPendingTemplateMedia`. That means the only way to preview a
 * freshly-chosen image is a local blob URL, and each one holds its blob
 * alive until revoked, so the cleanup here is load-bearing rather than
 * tidiness: a user cycling through a dozen images in the builder would
 * otherwise pin all twelve in memory for the life of the page.
 *
 * The URL is derived during render rather than pushed through state, so
 * the first paint already has it — a state-setting effect would render
 * one frame with no preview.
 */
export function useObjectUrl(file: File | null | undefined): string | undefined {
  const url = useMemo(
    () => (file ? URL.createObjectURL(file) : undefined),
    [file],
  );

  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return url;
}
