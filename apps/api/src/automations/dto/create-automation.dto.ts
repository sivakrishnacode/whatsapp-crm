import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { StepDto } from './step.dto';
import { CHANNELS } from '../../common/messaging/channel';

export class CreateAutomationDto {
  // Optional at the DTO level because the template-seeding path can
  // supply name/trigger_type — the "required" check runs in the
  // service after template resolution, matching the original route.
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  trigger_type?: string;

  @IsOptional()
  @IsObject()
  trigger_config?: Record<string, unknown>;

  /**
   * Channels this automation runs on. Omit or send `[]` for "all
   * channels" — the default.
   *
   * Validated with `@IsIn` per element, not left as a free string
   * array: a typo like `'instgram'` would otherwise persist happily
   * and produce an automation that shows as Active and silently never
   * fires. (The DB CHECK catches it too; this returns a 400 that names
   * the field instead of a constraint violation.)
   */
  @IsOptional()
  @IsArray()
  @IsIn(CHANNELS, { each: true })
  channels?: string[];

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StepDto)
  steps?: StepDto[];

  @IsOptional()
  @IsString()
  template?: string;
}
