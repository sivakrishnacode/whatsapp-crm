import { Allow } from 'class-validator';

/**
 * Body for POST /flows.
 *
 * Deliberately permissive: the original Next.js route did all its
 * validation inline with specific `{ error: string }` messages the
 * dashboard displays verbatim. Fields are only @Allow()-listed so the
 * global whitelist ValidationPipe doesn't strip them — FlowsService
 * re-implements the original checks with the original messages.
 */
export class CreateFlowDto {
  @Allow()
  name?: string;

  @Allow()
  description?: string | null;

  @Allow()
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual';

  @Allow()
  trigger_config?: Record<string, unknown>;

  /**
   * If set, clone the matching template's name + trigger +
   * entry_node_id + nodes[] into a fresh draft for this user.
   * `name` from the body overrides the template default if provided.
   */
  @Allow()
  template_slug?: string;
}
