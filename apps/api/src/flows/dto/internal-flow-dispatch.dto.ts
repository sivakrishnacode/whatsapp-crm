import { Allow, IsBoolean, IsObject, IsUUID } from 'class-validator';

/**
 * Body for the machine-to-machine POST /internal/flows/dispatch bridge —
 * the wire form of the engine's DispatchInboundInput. Sent by apps/web's
 * WhatsApp webhook route, which previously called `dispatchInboundToFlows`
 * in-process.
 *
 * `message` is validated structurally in the controller (its two
 * ParsedInbound variants share no required fields class-validator can
 * express cleanly); a malformed message dispatches as no-op rather than
 * 500ing the bridge.
 */
export class InternalFlowDispatchDto {
  @IsUUID()
  account_id!: string;

  @IsUUID()
  user_id!: string;

  @IsUUID()
  contact_id!: string;

  @IsUUID()
  conversation_id!: string;

  @IsBoolean()
  is_first_inbound_message!: boolean;

  @IsObject()
  @Allow()
  message!: Record<string, unknown>;
}
