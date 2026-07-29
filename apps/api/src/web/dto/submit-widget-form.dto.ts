import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitWidgetFormDto {
  /**
   * Answers keyed by field_key. Loose here on purpose — the shape belongs
   * to whichever form is being submitted, and `form-validate.ts` is the
   * authority on whether it is acceptable.
   */
  @IsObject()
  answers!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  page_url?: string;

  @IsOptional()
  @IsObject()
  spam?: { honeypot?: string; elapsedMs?: number };

  /**
   * Read from the raw body by the guards, which run before validation.
   * Declared so `whitelist: true` does not strip them.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  session_token?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  widget_key?: string;
}
