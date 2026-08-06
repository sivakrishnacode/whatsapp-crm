import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Shared query/body DTOs for the read and control surfaces.
 */

/** `YYYY-MM-DD`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AdsRangeQueryDto {
  /**
   * Inclusive start, `YYYY-MM-DD`. Defaults to 7 days ago.
   *
   * A pattern rather than `@IsDateString()`: the latter also accepts a
   * full timestamp, which would land in a `DATE` comparison against
   * `date_start` and silently exclude the first day depending on the
   * time component.
   */
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE, { message: 'since must be YYYY-MM-DD' })
  since?: string;

  /** Inclusive end, `YYYY-MM-DD`. Defaults to today. */
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE, { message: 'until must be YYYY-MM-DD' })
  until?: string;
}

export class SetObjectStatusDto {
  /**
   * Only pause and resume are exposed.
   *
   * No DELETE: deleting a campaign takes its spend history with it, and
   * there is no undo. ARCHIVED is likewise absent until there is a UI
   * that explains what it means — a dropdown with four irreversible
   * options is a support ticket.
   */
  @IsIn(['ACTIVE', 'PAUSED'])
  status!: 'ACTIVE' | 'PAUSED';
}

export class AdsCampaignParamDto {
  /** Our local uuid, not the Meta id — the route resolves both scoped to the account. */
  @IsString()
  @MaxLength(64)
  campaignId!: string;
}
