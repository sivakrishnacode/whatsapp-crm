import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class StepBranchesDto {
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StepDto)
  yes?: StepDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StepDto)
  no?: StepDto[];
}

export class StepDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  step_type!: string;

  @IsObject()
  step_config!: Record<string, unknown>;

  /**
   * Author-facing reference (migration 080) — `{{ steps.<key>.… }}` and
   * the canvas node id. Optional: a client that predates the canvas must
   * still be able to save, and the tree service mints one.
   *
   * Not validated for shape here — `uniqueKey()` sanitises it to
   * `[a-z0-9_]`, and rejecting a save because someone typed a space
   * would lose their work over a fixable detail.
   */
  @IsOptional()
  @IsString()
  key?: string | null;

  /** Canvas coordinates. Absent = never laid out; the editor auto-lays-out. */
  @IsOptional()
  @IsNumber()
  position_x?: number | null;

  @IsOptional()
  @IsNumber()
  position_y?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => StepBranchesDto)
  branches?: StepBranchesDto;

  // Legacy flat form (from template seeds):
  @IsOptional()
  @IsIn(['yes', 'no'])
  branch?: 'yes' | 'no' | null;

  @IsOptional()
  parent_index?: number | null;
}
