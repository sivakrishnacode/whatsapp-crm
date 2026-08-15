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
export function useAgentStudio(accountId: string | null, agentId: string) {
  const [studio, setStudio] = useState<AgentStudio | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState(false);
  const loadedKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai/agents/${agentId}`, { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // A deleted agent is not an error to toast at somebody — the
        // page shows "this agent is gone" and offers the list.
        if (res.status === 404) {
          setMissing(true);
          return;
        }
        toast.error(data?.error ?? 'Could not load the agent.');
        return;
      }
      setStudio(data as AgentStudio);
    } catch {
      toast.error('Could not load the agent.');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // Keyed on BOTH ids: switching agent within the same workspace must
  // refetch, and so must switching workspace on the same agent id.
  useEffect(() => {
    const key = `${accountId ?? ''}:${agentId}`;
    if (!accountId || !agentId || loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    void load();
  }, [accountId, agentId, load]);

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
        const res = await fetch(`/api/ai/agents/${agentId}`, {
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
    [agentId, load],
  );

  /**
   * Replace which library documents / actions this agent may use.
   *
   * Separate from `patch` because it is not a column on the row: it is a
   * pair of link tables, replaced whole inside one transaction.
   */
  const setLibrary = useCallback(
    async (
      body: { document_ids?: string[]; action_ids?: string[] },
      opts: { successMessage?: string } = {},
    ): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(`/api/ai/agents/${agentId}/library`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data?.error ?? 'Could not save.');
          return false;
        }
        toast.success(opts.successMessage ?? 'Saved.');
        void load();
        return true;
      } catch {
        toast.error('Could not save.');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [agentId, load],
  );

  return { studio, loading, saving, missing, reload: load, patch, setLibrary };
}
