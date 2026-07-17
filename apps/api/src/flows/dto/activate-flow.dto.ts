import { Allow } from 'class-validator';

/**
 * Body for POST /flows/:id/activate. The status value is validated in
 * FlowsService so an invalid value produces the original route's exact
 * `{ error: "status must be one of 'draft' | 'active' | 'archived'" }`.
 */
export class ActivateFlowDto {
  @Allow()
  status?: string;
}
