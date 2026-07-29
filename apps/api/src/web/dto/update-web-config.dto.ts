import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  IsUUID,
} from 'class-validator';

export class WidgetAppearanceDto {
  /**
   * Interpolated into the widget's inline styles, so it is length- and
   * charset-bounded rather than free text: a `</style>` in here would be
   * a stored-XSS vector on the customer's own page.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  accent?: string;

  @IsOptional()
  @IsIn(['left', 'right'])
  position?: 'left' | 'right';

  @IsOptional()
  @IsIn(['light', 'dark', 'auto'])
  theme?: 'light' | 'dark' | 'auto';

  @IsOptional()
  @IsString()
  @MaxLength(32)
  launcher_icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  subtitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  greeting?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  teaser?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  teaser_delay_seconds?: number;
}

export class UpdateWebConfigDto {
  /**
   * Origins permitted to embed the widget. Free-form strings here
   * because the service normalises them (`normalizeOriginList`) and
   * drops anything unparseable — validating the exact shape at this
   * layer would reject `example.com`, which is what users actually type.
   *
   * Capped so a settings save cannot be used to write an unbounded array.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  allowed_origins?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => WidgetAppearanceDto)
  appearance?: WidgetAppearanceDto;

  /**
   * `null` clears the schedule, which means "always open". Left as a
   * loose object: the shape is validated in business-hours.util.ts,
   * which is also what the widget reads, so there is one authority
   * rather than two that can disagree.
   */
  @IsOptional()
  @IsObject()
  business_hours?: Record<string, unknown> | null;

  @IsOptional()
  @IsBoolean()
  ai_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  show_branding?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  /**
   * Only these two are settable by a client. `disconnected` is a fact
   * about whether a live load has been observed, not a preference —
   * letting a client assert it would let the UI lie about installation.
   */
  @IsOptional()
  @IsIn(['connected', 'disabled'])
  status?: 'connected' | 'disabled';

  /**
   * Forms shown before the chat starts and outside business hours.
   *
   * `ValidateIf` rather than plain `@IsOptional` + `@IsUUID`: `null` is a
   * meaningful value here (clear the form) and `@IsUUID` would reject it,
   * so the check has to be skipped for null while still rejecting a
   * non-uuid string.
   */
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  prechat_form_id?: string | null;

  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  offline_form_id?: string | null;
}
