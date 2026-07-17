import { Allow } from 'class-validator';

/** The shape of a single exported node (stripped of DB ids). */
export interface ImportedNodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  position_x?: number;
  position_y?: number;
}

/** The flow block inside an export payload. */
export interface ImportedFlowInput {
  name: string;
  description?: string | null;
  status?: string;
  trigger_type: 'keyword' | 'first_inbound_message' | 'manual';
  trigger_config?: Record<string, unknown>;
  entry_node_id?: string | null;
  fallback_policy?: Record<string, unknown>;
}

/**
 * Body for POST /flows/import — the shape produced by
 * GET /flows/:id/export. Permissive by design; FlowsService validates
 * with the original route's exact error messages.
 */
export class ImportFlowDto {
  @Allow()
  schema_version?: number;

  @Allow()
  exported_at?: string;

  @Allow()
  flow?: ImportedFlowInput;

  @Allow()
  nodes?: ImportedNodeInput[];
}
