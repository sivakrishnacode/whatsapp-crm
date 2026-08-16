/**
 * The AI flow draft, and how it reaches the builder.
 *
 * Two routes in, one shape out:
 *   - From the editor's prompt bar, the draft is applied to the flow
 *     already open — with a confirmation, because it REPLACES what is on
 *     the canvas.
 *   - From /flows, the draft rides to a newly-created empty flow through
 *     sessionStorage (the URL cannot carry a graph, and writing it to the
 *     database first is exactly what the approval step exists to
 *     prevent). Read once and removed, or a refresh silently re-seeds a
 *     draft the author has since edited.
 *
 * ⚠️ NOTHING HERE IS SAVED. `draftToBuilder` produces editor state; the
 *   author still presses Save, which runs the same validation every
 *   other save does.
 */

import {
  ADDABLE_NODE_TYPES,
  defaultConfigFor,
  type BuilderNode,
  type NodeType,
} from '@/components/flows/shared';

export interface AiFlowDraft {
  name: string;
  description: string;
  trigger_type: 'keyword' | 'first_inbound_message' | 'manual';
  trigger_config: Record<string, unknown>;
  entry_node_key: string;
  nodes: Array<{
    node_key: string;
    node_type: string;
    config: Record<string, unknown>;
  }>;
  /** Caveats the model raised, plus anything the parser corrected. */
  notes: string[];
  /** Ids the author still has to pick. */
  needs: string[];
}

export interface AiFlowDraftResponse {
  draft: AiFlowDraft;
  credits_used?: number;
  credits_remaining?: number;
}

const KEY_PREFIX = 'flow-ai-draft:';

/** Stash a draft for the editor to pick up, returning its handoff id. */
export function stashFlowDraft(draft: AiFlowDraft): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    sessionStorage.setItem(KEY_PREFIX + id, JSON.stringify(draft));
  } catch {
    // Private-mode Safari and a full quota both throw here. The caller
    // navigates either way and the editor opens blank rather than
    // crashing — worse than the happy path, better than a dead button.
  }
  return id;
}

/** Read a stashed draft and remove it. Returns null if it is not there. */
export function takeFlowDraft(id: string | null): AiFlowDraft | null {
  if (!id) return null;
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + id);
    if (!raw) return null;
    sessionStorage.removeItem(KEY_PREFIX + id);
    return JSON.parse(raw) as AiFlowDraft;
  } catch {
    return null;
  }
}

/**
 * Turn a draft into builder nodes.
 *
 * ⚠️ THE API'S PARSER IS THE AUTHORITY; this is a second, cheaper pass
 * for the case where a stale tab meets a newer server. It drops any node
 * type this build does not know rather than rendering a card no form can
 * edit, and merges each config over the type's defaults so a field the
 * model omitted exists (empty) instead of being undefined — which is what
 * the forms and the validator both expect.
 *
 * Positions are left unset on purpose: NULL means "never laid out", so
 * the canvas runs dagre and the graph arrives readable.
 */
export function draftToBuilderNodes(draft: AiFlowDraft): BuilderNode[] {
  const known = new Set<string>(ADDABLE_NODE_TYPES);
  return draft.nodes
    .filter((n) => known.has(n.node_type))
    .map((n) => ({
      node_key: n.node_key,
      node_type: n.node_type as NodeType,
      config: {
        ...defaultConfigFor(n.node_type as NodeType),
        ...n.config,
      },
    }));
}

/** A one-line summary for the confirmation, e.g. "6 nodes · 2 questions". */
export function describeDraft(draft: AiFlowDraft): string {
  const nodes = draft.nodes.length;
  const asks = draft.nodes.filter(
    (n) =>
      n.node_type === 'collect_input' ||
      n.node_type === 'ask_location' ||
      n.node_type === 'ask_media'
  ).length;
  const branches = draft.nodes.filter(
    (n) => n.node_type === 'condition' || n.node_type === 'send_buttons'
  ).length;

  const parts = [`${nodes} node${nodes === 1 ? '' : 's'}`];
  if (asks > 0) parts.push(`${asks} question${asks === 1 ? '' : 's'}`);
  if (branches > 0)
    parts.push(`${branches} branch${branches === 1 ? '' : 'es'}`);
  return parts.join(' · ');
}
