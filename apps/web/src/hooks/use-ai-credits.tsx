'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from '@/hooks/use-auth';

export interface CreditPack {
  code: string;
  display_name: string;
  credits: number;
  /** Minor units (paise). Formatted at the edge, never stored as a float. */
  price_minor: number;
  currency: string;
  badge: string | null;
}

export interface AiCreditsState {
  balance: number;
  low: boolean;
  low_threshold: number;
  lifetime_purchased: number;
  lifetime_consumed: number;
  credit_mode: 'platform' | 'byok';
  has_own_key: boolean;
  platform_available: boolean;
  packs: CreditPack[];
}

interface AiCreditsContextValue {
  credits: AiCreditsState | null;
  loading: boolean;
  /** Refetch from the server. */
  reload: () => Promise<void>;
  /**
   * Write a balance we already know — the draft and playground responses
   * return it, so the badge can settle immediately instead of waiting on
   * a refetch that renders a stale number in between.
   */
  setBalance: (balance: number) => void;
}

const AiCreditsContext = createContext<AiCreditsContextValue>({
  credits: null,
  loading: true,
  reload: async () => {},
  setBalance: () => {},
});

/**
 * ============================================================
 * One source of truth for the credit balance.
 *
 * A context rather than a hook-per-component because at least three
 * things show this number at once — the header badge, the recharge
 * sheet, and the Provider tab — and three independent fetches would
 * show three different balances the moment one of them spends a credit.
 *
 * Mounted in the dashboard shell, so it is available everywhere behind
 * the auth gate and nowhere in front of it.
 * ============================================================
 */
export function AiCreditsProvider({ children }: { children: React.ReactNode }) {
  const { accountId } = useAuth();
  const [credits, setCredits] = useState<AiCreditsState | null>(null);
  const [loading, setLoading] = useState(true);
  // Keyed on the account, so switching workspace refetches rather than
  // showing the previous one's balance.
  const loadedFor = useRef<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/credits', { cache: 'no-store' });
      if (!res.ok) {
        // A failed balance read must never block the dashboard. The
        // badge simply does not render, which is strictly better than a
        // toast on every page load telling someone their AI might be
        // fine.
        setCredits(null);
        return;
      }
      setCredits((await res.json()) as AiCreditsState);
    } catch {
      setCredits(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId) return;
    if (loadedFor.current === accountId) return;
    loadedFor.current = accountId;
    void reload();
  }, [accountId, reload]);

  const setBalance = useCallback((balance: number) => {
    setCredits((prev) =>
      prev ? { ...prev, balance, low: balance <= prev.low_threshold } : prev,
    );
  }, []);

  const value = useMemo(
    () => ({ credits, loading, reload, setBalance }),
    [credits, loading, reload, setBalance],
  );

  return (
    <AiCreditsContext.Provider value={value}>
      {children}
    </AiCreditsContext.Provider>
  );
}

export function useAiCredits() {
  return useContext(AiCreditsContext);
}
