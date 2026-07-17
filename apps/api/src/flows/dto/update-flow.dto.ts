import { Allow } from 'class-validator';

export interface UpdateFlowNodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  position_x?: number;
  position_y?: number;
}

/**
 * Body for PUT /flows/:id. Permissive by design — see CreateFlowDto's
 * note; FlowsService owns the validation + error messages.
 */
export class UpdateFlowDto {
  @Allow()
  name?: string;

  @Allow()
  description?: string | null;

  @Allow()
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual';

  @Allow()
  trigger_config?: Record<string, unknown>;

  @Allow()
  entry_node_id?: string | null;

  @Allow()
  fallback_policy?: Record<string, unknown>;

  @Allow()
  nodes?: UpdateFlowNodeInput[];
}
