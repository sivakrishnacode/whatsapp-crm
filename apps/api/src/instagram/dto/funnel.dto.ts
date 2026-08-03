import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * A link-out button on the reward message.
 *
 * `url` is validated as http(s) here as well as by the DB's
 * `parseRewardButtons` filter — belt and braces on purpose. This value
 * ends up in a button Meta renders to the public, and a `javascript:`
 * URL that reached that far would be the business's problem, not ours.
 */
export class RewardButtonDto {
  @IsString()
  @MinLength(1)
  // Meta's button-title cap. Longer titles are rejected at send time,
  // i.e. after the visitor has already opted in — so it is caught here.
  @MaxLength(20)
  label!: string;

  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2000)
  url!: string;
}

export class CreateFunnelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Omitted or null = every post, present and future. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ig_media_id?: string | null;

  /** Empty = match any comment. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @ArrayMaxSize(50)
  keywords?: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  optin_text!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  optin_button_label?: string;

  @IsOptional()
  @IsBoolean()
  follow_gate_enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  follow_ask_text?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  follow_button_label?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reward_text!: string;

  /** Meta renders at most 3 buttons on a button template. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => RewardButtonDto)
  reward_buttons?: RewardButtonDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public_reply_text?: string | null;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

/**
 * Every field optional — a PATCH that only flips `is_active` must not
 * have to resend the whole funnel body.
 */
export class UpdateFunnelDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ig_media_id?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @ArrayMaxSize(50)
  keywords?: string[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  optin_text?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  optin_button_label?: string;

  @IsOptional()
  @IsBoolean()
  follow_gate_enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  follow_ask_text?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  follow_button_label?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reward_text?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => RewardButtonDto)
  reward_buttons?: RewardButtonDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public_reply_text?: string | null;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

/** The account master switch, separate from any one funnel. */
export class ToggleFunnelsDto {
  @IsBoolean()
  enabled!: boolean;
}

export class ListRunsQueryDto {
  @IsOptional()
  @IsIn(['awaiting_optin', 'awaiting_follow', 'delivered', 'failed'])
  state?: string;
}
