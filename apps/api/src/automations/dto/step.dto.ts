import { Type } from 'class-transformer';
import {
  IsIn,
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
