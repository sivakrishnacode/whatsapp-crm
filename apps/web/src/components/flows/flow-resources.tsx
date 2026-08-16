'use client';

/**
 * Account resources the flow node forms pick from — approved templates,
 * catalogue products, custom fields, other flows, and AI agents.
 *
 * Loaded once at the editor root and shared by context, so opening ten
 * nodes does not fetch the same template list ten times. Mirrors
 * `components/automations/canvas/resources.tsx`, deliberately: the two
 * editors ask different questions (no pipelines here, no products
 * there) and merging them would mean every flow editor paying for the
 * automation editor's nine queries.
 *
 * ⚠️ EVERY PICKER FALLS BACK TO A RAW ID INPUT WHEN ITS LIST IS EMPTY.
 *   A fresh account, an un-synced catalogue or a failed request must not
 *   make a node unauthorable — the id typed by hand is the same string
 *   the picker would have produced. This is why nothing here throws and
 *   why each query is independent.
 *
 * Reads go straight to Postgres through the browser client, so RLS
 * scopes them to the caller's account — the same path the automation
 * editor uses.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import { createClient } from '@/lib/supabase/client';
import type { CustomField, MessageTemplate } from '@/types';

export interface FlowOption {
  id: string;
  name: string;
  status: string;
}

export interface ProductOption {
  retailer_id: string;
  name: string;
  price: string | number;
  currency: string;
}

export interface AgentOption {
  id: string;
  name: string;
  is_active: boolean;
}

export interface FlowResources {
  templates: MessageTemplate[];
  customFields: CustomField[];
  /** Other flows in this workspace — the `start_flow` picker. */
  flows: FlowOption[];
  products: ProductOption[];
  agents: AgentOption[];
}

const EMPTY: FlowResources = {
  templates: [],
  customFields: [],
  flows: [],
  products: [],
  agents: [],
};

const ResourcesContext = createContext<FlowResources>(EMPTY);

export function useFlowResources(): FlowResources {
  return useContext(ResourcesContext);
}

export function FlowResourcesProvider({
  currentFlowId,
  children,
}: {
  /** Excluded from the `flows` list — a flow cannot connect to itself. */
  currentFlowId?: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<FlowResources>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    void (async () => {
      // Only APPROVED templates can actually be sent — anything else
      // 400s at send time, so offering them would be offering a node
      // that cannot run. Same filter as the broadcast picker.
      const [templatesRes, customFieldsRes, productsRes] = await Promise.all([
        supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED')
          .order('name'),
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('whatsapp_products')
          .select('retailer_id, name, price, currency')
          .eq('is_active', true)
          .order('name'),
      ]);
      if (cancelled) return;
      setState((s) => ({
        ...s,
        templates: (templatesRes.data as MessageTemplate[] | null) ?? [],
        customFields: (customFieldsRes.data as CustomField[] | null) ?? [],
        products: (productsRes.data as ProductOption[] | null) ?? [],
      }));
    })();

    // Its own request: the flow list comes from the API (which applies
    // the same account scoping as the flows page) and a failure here
    // must not take the templates down with it.
    void (async () => {
      try {
        const res = await fetch('/api/flows', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { flows?: FlowOption[] };
        if (cancelled) return;
        setState((s) => ({
          ...s,
          flows: (json.flows ?? []).filter((f) => f.id !== currentFlowId),
        }));
      } catch {
        // Falls back to a raw id input.
      }
    })();

    void (async () => {
      const res = await supabase
        .from('ai_agents')
        .select('id, name, is_active')
        .order('priority');
      if (cancelled || res.error) return;
      setState((s) => ({
        ...s,
        agents: (res.data as AgentOption[] | null) ?? [],
      }));
    })();

    return () => {
      cancelled = true;
    };
  }, [currentFlowId]);

  return (
    <ResourcesContext.Provider value={state}>
      {children}
    </ResourcesContext.Provider>
  );
}
