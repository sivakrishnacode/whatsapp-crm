'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AgentListResponse, AgentSummary } from '@/lib/agents/types';

/**
 * The agent list, and the writes that act on a whole agent rather than a
 * field inside one: switch on, duplicate, delete, reorder.
 *
 * Editing an agent's CONFIGURATION is `useAgentStudio`'s job — one
 * screen, one PATCH per card. The split matches the API: this hook talks
 * to `/api/ai/agents`, that one to `/api/ai/agents/:id`.
 *
 * The load guard is keyed on accountId rather than a boolean, so an
 * in-place workspace switch refetches instead of showing the previous
 * workspace's agents.
 */
export function useAgents(accountId: string | null) {
  const [data, setData] = useState<AgentListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/agents', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error ?? 'Could not load your agents.');
        return;
      }
      setData(body as AgentListResponse);
    } catch {
      toast.error('Could not load your agents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void load();
  }, [accountId, load]);

  /** Switch one agent on or off, optimistically. */
  const setActive = useCallback(
    async (agent: AgentSummary, next: boolean) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              agents: prev.agents.map((a) =>
                a.id === agent.id ? { ...a, is_active: next } : a,
              ),
            }
          : prev,
      );

      const res = await fetch(`/api/ai/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Roll the switch back: leaving it flipped would claim an agent
        // is live when it is not, which is the one lie this screen must
        // never tell.
        setData((prev) =>
          prev
            ? {
                ...prev,
                agents: prev.agents.map((a) =>
                  a.id === agent.id ? { ...a, is_active: !next } : a,
                ),
              }
            : prev,
        );
        toast.error(body?.error ?? 'Could not update that agent.');
        return false;
      }

      toast.success(next ? `${agent.name} is on.` : `${agent.name} is paused.`);
      void load();
      return true;
    },
    [load],
  );

  const create = useCallback(
    async (input: { name?: string; template_id?: string | null }) => {
      setBusy(true);
      try {
        const res = await fetch('/api/ai/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(body?.error ?? 'Could not create that agent.');
          return null;
        }
        void load();
        return body.agent as AgentSummary;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const duplicate = useCallback(
    async (agent: AgentSummary) => {
      const res = await fetch(`/api/ai/agents/${agent.id}/duplicate`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error ?? 'Could not duplicate that agent.');
        return null;
      }
      toast.success(`Copied ${agent.name}. The copy is switched off.`);
      void load();
      return body.agent as AgentSummary;
    },
    [load],
  );

  const remove = useCallback(
    async (agent: AgentSummary) => {
      const res = await fetch(`/api/ai/agents/${agent.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.error ?? 'Could not delete that agent.');
        return false;
      }
      toast.success(`${agent.name} deleted.`);
      void load();
      return true;
    },
    [load],
  );

  /**
   * Save the routing order. Takes the whole list, like the endpoint: a
   * partial order written by two people at once produces an order
   * neither of them chose.
   */
  const reorder = useCallback(
    async (agents: AgentSummary[]) => {
      setData((prev) => (prev ? { ...prev, agents } : prev));

      const res = await fetch('/api/ai/agents/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_ids: agents.map((a) => a.id) }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.error ?? 'Could not save that order.');
        void load();
        return false;
      }
      return true;
    },
    [load],
  );

  return {
    data,
    loading,
    busy,
    reload: load,
    setActive,
    create,
    duplicate,
    remove,
    reorder,
  };
}
