import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { LEAD_FORM_QUESTION_TYPES } from '../marketing-leadforms.util';
import { AdTargetingDto } from './ads-publish.dto';

/** DTOs for media, lead forms, audiences and targeting search. */

/**
 * Creative upload.
 *
 * Base64 in a JSON body rather than multipart, matching
 * `UploadWebMediaDto` — this API has no multipart parser and
 * `@types/multer` is not a dependency, so adding one for a single
 * endpoint would be the larger change.
 *
 * The string cap is ~40 MB of base64, which decodes to a little over the
 * 30 MB image limit Meta enforces. Sized deliberately above it so an
 * oversized file is rejected by `AdsAssetsService` with a message naming
 * the real MB limit, rather than by this validator complaining about a
 * base64 length no user can reason about.
 *
 * Videos are therefore capped by this DTO well below Meta's own ceiling.
 * That is a deliberate v1 limit: a 200 MB base64 body is not a sensible
 * request shape, and a resumable upload endpoint is the right answer if
 * long-form video ads are ever wanted.
 */
export class UploadAdMediaDto {
  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @MaxLength(128)
  contentType!: string;

  @IsString()
  @MaxLength(40_000_000)
  dataBase64!: string;
}

export class SearchTargetingQueryDto {
  @IsString()
  @MinLength(2, { message: 'Type at least two characters to search.' })
  @MaxLength(120)
  q!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(['country', 'region', 'city', 'zip'], { each: true })
  types?: Array<'country' | 'region' | 'city' | 'zip'>;
}

export class LeadFormQuestionDto {
  @IsIn(LEAD_FORM_QUESTION_TYPES as unknown as string[])
  type!: string;

  /** Required for CUSTOM; Meta supplies the label for every other type. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'key must be lowercase letters, digits and underscores',
  })
  key?: string;
}

export class CreateLeadFormDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LeadFormQuestionDto)
  questions!: LeadFormQuestionDto[];

  /**
   * Required by Meta for every lead form, with no way to opt out — it is
   * a legal requirement rather than a setting.
   */
  @IsString()
  @MaxLength(2048)
  @Matches(/^https?:\/\//, {
    message: 'privacyPolicyUrl must start with https://',
  })
  privacyPolicyUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  thankYouTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  thankYouBody?: string;
}

export class CreateAudienceFromContactsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  /** Omit for every contact with a phone number. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  tagIds?: string[];

  /**
   * Also upload email addresses. Off by default — see the service: phones
   * are the identifier every contact has, emails are patchy, and each
   * schema is a separate upload.
   */
  @IsOptional()
  @IsBoolean()
  includeEmails?: boolean;
}

export class CreateSavedAudienceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  /**
   * The targeting to store, in the wizard's own shape. Converted to Meta's
   * spec server-side by `AdsTargetingService.toTargetingInput` +
   * `buildTargeting`, so a saved audience and the ad set it came from are
   * guaranteed to encode the same thing.
   */
  @ValidateNested()
  @Type(() => AdTargetingDto)
  targeting!: AdTargetingDto;
}

export class CreateLookalikeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsString()
  @MaxLength(64)
  sourceAudienceId!: string;

  /** ISO 3166-1 alpha-2. The lookalike is grown within one country. */
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: 'country must be a two-letter uppercase country code, e.g. IN',
  })
  country!: string;

  /**
   * Share of the country's population. 0.01 = the closest 1%, and the
   * most similar to the seed; Meta's ceiling is 0.20.
   */
  @IsNumber()
  @Min(0.01)
  @Max(0.2)
  ratio!: number;
}
