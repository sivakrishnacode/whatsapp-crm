'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AgentStudio } from '@/lib/agents/types';

/**
 * One fetch for the whole Agent Studio, and one PATCH to save any part
 * of it.
 *
 * WHY PATCH-A-PARTIAL RATHER THAN PUT-THE-FORM
 *   The studio is six tabs over one row. If each tab sent its whole
 *   state, a stale tab would quietly overwrite a change made on another
 *   one — and the server, which only touches keys that are present,
 *   would have no way to tell. Sending just the fields a card owns makes
 *   that impossible.
 *
 * The guard is keyed on accountId, not a boolean, so an in-place account
 * switch refetches instead of showing the previous workspace's agent.
 */
export function useAgentStudio(accountId: string | null) {
  const [studio, setStudio] = useState<AgentStudio | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/agent', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? 'Could not load the agent.');
        return;
      }
      setStudio(data as AgentStudio);
    } catch {
      toast.error('Could not load the agent.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void load();
  }, [accountId, load]);

  /**
   * Save a partial. Returns true on success so a caller can clear its
   * dirty state only when the write actually landed.
   */
  const patch = useCallback(
    async (
      body: Record<string, unknown>,
      opts: { successMessage?: string; silent?: boolean } = {},
    ): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch('/api/ai/agent', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data?.error ?? 'Could not save.');
          return false;
        }
        // Optimistically fold the change in, then refetch so derived
        // fields (knowledge counts, updated_at) stay truthful.
        setStudio((prev) => (prev ? { ...prev, ...body } : prev));
        if (!opts.silent) toast.success(opts.successMessage ?? 'Saved.');
        void load();
        return true;
      } catch {
        toast.error('Could not save.');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  return { studio, loading, saving, reload: load, patch };
}
