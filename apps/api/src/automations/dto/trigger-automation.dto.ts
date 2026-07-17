import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

/** Body for the user-facing POST /automations/engine manual trigger. */
export class TriggerAutomationDto {
  @IsString()
  trigger_type!: string;

  @IsOptional()
  @IsUUID()
  contact_id?: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}
