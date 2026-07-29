import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class VisitorIdentityDto {
  /** The customer's own user id for this visitor. */
  @IsString()
  @MaxLength(200)
  external_id!: string;

  /** HMAC-SHA256 of `external_id`, keyed with the account's widget secret. */
  @IsString()
  @MaxLength(128)
  hmac!: string;
}

export class VisitorProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}

export class StartSessionDto {
  /**
   * A token from a previous visit. Its presence is what distinguishes
   * resuming a thread from starting one, so a widget that loses it silently
   * strands the visitor's history.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  session_token?: string;

  /** Attribution. Capped rather than unbounded — these are public inputs. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  page_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  referrer?: string;

  @IsOptional()
  @IsObject()
  utm?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => VisitorIdentityDto)
  identity?: VisitorIdentityDto;

  /**
   * Details the visitor volunteered, e.g. through a pre-chat form. Applied
   * only where we have nothing already — see `applyProfile`.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => VisitorProfileDto)
  profile?: VisitorProfileDto;
}
