import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

/** Body for the machine-to-machine POST /internal/automations/dispatch bridge. */
export class InternalDispatchDto {
  @IsUUID()
  account_id!: string;

  @IsString()
  trigger_type!: string;

  @IsOptional()
  @IsUUID()
  contact_id?: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}
