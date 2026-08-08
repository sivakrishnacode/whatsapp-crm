import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAX_LOGO_URL_LEN } from '../../common/storage/workspace-logo.util';

/**
 * Answer vocabularies.
 *
 * These are validated server-side but stored as plain text, not enums —
 * the option lists will churn with marketing's questions far faster
 * than a migration should. The web app's copy lives in
 * `apps/web/src/lib/onboarding/questions.ts` and must stay in step with
 * these keys; anything unrecognised is rejected rather than silently
 * recorded, otherwise the funnel reports quietly rot.
 */
export const ONBOARDING_GOALS = [
  'shared_inbox',
  'broadcasts',
  'automations',
  'flows',
  'pipeline',
  'ecommerce',
  'ai_assistant',
  'api_integrations',
] as const;

export const TEAM_SIZES = ['1', '2-5', '6-20', '21-50', '50+'] as const;

export const REFERRAL_SOURCES = [
  'google',
  'referral',
  'social',
  'whatsapp_group',
  'event',
  'other',
] as const;

/** Mirrors the `name` cap enforced by PATCH /account. */
export const MAX_WORKSPACE_NAME_LEN = 80;

/** Step 1 — name the workspace and answer the qualification questions. */
export class SaveWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_WORKSPACE_NAME_LEN)
  workspaceName!: string;

  @IsArray()
  // One entry per option is the ceiling; anything longer is a client bug
  // or someone posting by hand.
  @ArrayMaxSize(ONBOARDING_GOALS.length)
  @IsIn(ONBOARDING_GOALS, { each: true })
  goals!: string[];

  @IsIn(TEAM_SIZES)
  teamSize!: string;

  @IsIn(REFERRAL_SOURCES)
  referralSource!: string;

  /** Only meaningful when referralSource is 'other'; ignored otherwise. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  referralOther?: string;

  /**
   * Public URL of a logo the visitor already uploaded to the
   * `workspace-logos` bucket. Optional and deliberately so — this is the
   * first screen of the product, and a file picker must never stand
   * between someone and their account. `null` clears a logo picked on an
   * earlier pass through the step.
   *
   * Validated for shape here; pinned to this account's own storage
   * folder by the service (see `normalizeWorkspaceLogoUrl`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LOGO_URL_LEN)
  logoUrl?: string | null;
}

/** Step 2 — pick a plan. FREE is not selectable; it is no longer active. */
export class SelectPlanDto {
  @IsString()
  @MaxLength(40)
  planName!: string;
}

/** Step 2, Enterprise branch — hand off to sales. */
export class PlanEnquiryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName!: string;

  @IsEmail()
  @MaxLength(320)
  workEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsIn(TEAM_SIZES)
  companySize?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}
