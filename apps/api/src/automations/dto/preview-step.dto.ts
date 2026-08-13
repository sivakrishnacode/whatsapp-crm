import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Body for `preview-step` / `test-step`.
 *
 * The step is sent WHOLE rather than referenced by id: the author is
 * testing what is on screen, which may never have been saved. Requiring
 * a save first is how people stop testing.
 */
export class PreviewStepDto {
  @IsString()
  step_type!: string;

  @IsOptional()
  @IsObject()
  step_config?: Record<string, unknown>;

  /**
   * Only used to look up what EARLIER steps returned on previous runs,
   * so their outputs can stand in as sample data. Account-scoped when
   * read.
   */
  @IsOptional()
  @IsUUID()
  automation_id?: string;

  /** Preview against a specific person; defaults to the newest contact. */
  @IsOptional()
  @IsUUID()
  contact_id?: string;
}
