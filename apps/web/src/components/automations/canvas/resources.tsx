'use client';

/**
 * Account resources the step forms pick from — tags, segments, members,
 * approved templates, custom fields, pipelines, forms, appointment
 * types, flows and other automations.
 *
 * Loaded once at the editor root and shared by context so that opening
 * ten steps does not fetch the same tag list ten times. Every picker
 * falls back to a raw id input when its list is empty (a fresh account,
 * or an endpoint that is not deployed yet), so an automation is always
 * authorable even when this fails.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { createClient } from '@/lib/supabase/client';
import type { SampleData } from '@/lib/automations/tokens';
import type {
  AppConnection,
  CatalogApp,
} from '@/lib/automations/connectors';
import type {
  AccountMember,
  Automation,
  ContactSegment,
  CustomField,
  MessageTemplate,
  Tag as TagRecord,
} from '@/types';

export interface FlowOption {
  id: string;
  name: string;
  status?: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
}

interface NamedRow {
  id: string;
  name: string;
}

interface PipelineStageOption {
  id: string;
  name: string;
  pipeline_id: string;
  position: number;
}

export interface AutomationResources {
  tags: TagRecord[];
  /**
   * Connected-app catalogue and the workspace's connections.
   *
   * Both FETCHED, never hard-coded: the API validates against the same
   * field specs it serves here, so one authority means a field cannot
   * render without validating. See lib/automations/connectors.ts.
   */
  apps: CatalogApp[];
  connections: AppConnection[];
  segments: ContactSegment[];
  members: AccountMember[];
  templates: MessageTemplate[];
  customFields: CustomField[];
  pipelines: NamedRow[];
  stages: PipelineStageOption[];
  forms: NamedRow[];
  appointmentTypes: NamedRow[];
  automations: Automation[];
  flows: FlowOption[];
  /** So "run automation" can exclude this one — an automation calling
   *  itself is refused server-side, and offering it is a trap. */
  currentAutomationId?: string;
}

const EMPTY: AutomationResources = {
  tags: [],
  apps: [],
  connections: [],
  segments: [],
  members: [],
  templates: [],
  customFields: [],
  pipelines: [],
  stages: [],
  forms: [],
  appointmentTypes: [],
  automations: [],
  flows: [],
};

const ResourcesContext = createContext<AutomationResources>(EMPTY);

export function useAutomationResources(): AutomationResources {
  return useContext(ResourcesContext);
}

/**
 * Real values for the token picker: a contact from this workspace, their
 * last message, and what each step returned on recent runs.
 *
 * Its own context rather than a field on the resources object, because
 * it is read by every token picker on the screen and changes on a
 * different schedule from the pickers' option lists.
 */
const SampleDataContext = createContext<SampleData | undefined>(undefined);

export function useSampleData(): SampleData | undefined {
  return useContext(SampleDataContext);
}

export function AutomationResourcesProvider({
  currentAutomationId,
  children,
}: {
  currentAutomationId?: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<AutomationResources>(EMPTY);
  const [sample, setSample] = useState<SampleData | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    // Straight from Postgres — RLS scopes every one of these to the
    // caller's account. Only APPROVED templates can actually be sent
    // (anything else 400s at send time), matching the broadcast picker.
    void (async () => {
      const [
        tagsRes,
        segmentsRes,
        templatesRes,
        customFieldsRes,
        pipelinesRes,
        stagesRes,
        formsRes,
      ] = await Promise.all([
        supabase.from('tags').select('*').order('name'),
        supabase.from('contact_segments').select('*').order('name'),
        supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED')
          .order('name'),
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase.from('pipelines').select('id, name').order('name'),
        supabase
          .from('pipeline_stages')
          .select('id, name, pipeline_id, position')
          .order('position'),
        supabase
          .from('forms')
          .select('id, name, status')
          .eq('status', 'published')
          .order('name'),
      ]);
      if (cancelled) return;
      setState((s) => ({
        ...s,
        tags: (tagsRes.data as TagRecord[] | null) ?? [],
        segments: (segmentsRes.data as ContactSegment[] | null) ?? [],
        templates: (templatesRes.data as MessageTemplate[] | null) ?? [],
        customFields: (customFieldsRes.data as CustomField[] | null) ?? [],
        pipelines: (pipelinesRes.data as NamedRow[] | null) ?? [],
        stages: (stagesRes.data as PipelineStageOption[] | null) ?? [],
        forms: (formsRes.data as NamedRow[] | null) ?? [],
      }));
    })();

    // appointment_types arrived in migration 055 and may not exist on
    // every deployment yet. Its own query so a missing table cannot take
    // the tags and templates down with it.
    void (async () => {
      const res = await supabase
        .from('appointment_types')
        .select('id, name')
        .eq('is_active', true)
        .order('name');
      if (cancelled || res.error) return;
      setState((s) => ({
        ...s,
        appointmentTypes: (res.data as NamedRow[] | null) ?? [],
      }));
    })();

    // Members go through the API so we inherit its email-visibility
    // rules (agents and viewers do not see addresses).
    void (async () => {
      try {
        const res = await fetch('/api/account/members', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { members?: AccountMember[] };
        if (!cancelled) {
          setState((s) => ({ ...s, members: json.members ?? [] }));
        }
      } catch {
        // Falls back to a raw id input.
      }
    })();

    void (async () => {
      try {
        const res = await fetch('/api/automations', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { automations?: Automation[] };
        if (!cancelled) {
          setState((s) => ({ ...s, automations: json.automations ?? [] }));
        }
      } catch {
        // Optional — only "run automation" and the keyword-conflict
        // warning need it.
      }
    })();

    // The connected-app catalogue and this workspace's connections. Two
    // requests rather than one because the catalogue is static per
    // deploy while connections change whenever somebody connects an
    // account — and only the second needs re-fetching after an OAuth
    // round trip.
    void (async () => {
      try {
        const [catalogRes, connectionsRes] = await Promise.all([
          fetch('/api/connections/catalog', { cache: 'no-store' }),
          fetch('/api/connections', { cache: 'no-store' }),
        ]);
        const apps = catalogRes.ok
          ? ((await catalogRes.json()) as { apps?: CatalogApp[] }).apps ?? []
          : [];
        const connections = connectionsRes.ok
          ? ((await connectionsRes.json()) as { connections?: AppConnection[] })
              .connections ?? []
          : [];
        if (!cancelled) setState((s) => ({ ...s, apps, connections }));
      } catch {
        // Optional — only `app_action` steps need it, and the inspector
        // says so plainly when the list is empty.
      }
    })();

    void (async () => {
      try {
        const res = await fetch('/api/flows', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { flows?: FlowOption[] };
        if (!cancelled) setState((s) => ({ ...s, flows: json.flows ?? [] }));
      } catch {
        // Optional — only "start flow" needs it.
      }
    })();

    // Fetched once per open and reused by every picker: asking per field
    // would be one request per token on screen.
    void (async () => {
      try {
        const query = currentAutomationId
          ? `?automation_id=${encodeURIComponent(currentAutomationId)}`
          : '';
        const res = await fetch(`/api/automations/sample-data${query}`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const json = (await res.json()) as SampleData;
        if (!cancelled) setSample(json);
      } catch {
        // The picker still lists every token; it just cannot show what
        // each one currently holds.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentAutomationId]);

  const value = useMemo(
    () => ({ ...state, currentAutomationId }),
    [state, currentAutomationId],
  );

  return (
    <ResourcesContext.Provider value={value}>
      <SampleDataContext.Provider value={sample}>
        {children}
      </SampleDataContext.Provider>
    </ResourcesContext.Provider>
  );
}
