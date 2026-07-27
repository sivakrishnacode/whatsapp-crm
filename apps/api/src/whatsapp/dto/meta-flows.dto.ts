import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/** Meta's Flow category enum — at least one is required on create/update. */
export const META_FLOW_CATEGORIES = [
  'SIGN_UP',
  'SIGN_IN',
  'APPOINTMENT_BOOKING',
  'LEAD_GENERATION',
  'CONTACT_US',
  'CUSTOMER_SUPPORT',
  'SURVEY',
  'OTHER',
] as const;

export class CreateMetaFlowDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  /** Omitted when `templateId` is supplied — the template's category is used. */
  @IsOptional()
  @IsArray()
  @IsIn(META_FLOW_CATEGORIES, { each: true })
  categories?: string[];

  /** Raw Flow JSON string. Mutually exclusive with `templateId`/`cloneFlowId`. */
  @IsOptional()
  @IsString()
  flowJson?: string;

  /** Seed from a built-in starter template (see meta-flows-templates.ts). */
  @IsOptional()
  @IsString()
  templateId?: string;

  /** Clone an existing Meta flow the account has access to. */
  @IsOptional()
  @IsString()
  cloneFlowId?: string;

  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class UpdateMetaFlowDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsArray()
  @IsIn(META_FLOW_CATEGORIES, { each: true })
  categories?: string[];
}

export class UpdateMetaFlowJsonDto {
  @IsString()
  @IsNotEmpty()
  flowJson!: string;
}
