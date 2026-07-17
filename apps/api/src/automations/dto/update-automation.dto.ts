import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateAutomationDto } from './create-automation.dto';

/**
 * All fields optional — the service only touches keys actually present
 * in the parsed body (mirrors the original route's
 * `for (const k of [...]) if (k in body) update[k] = body[k]` loop).
 * `template` doesn't apply to updates.
 */
export class UpdateAutomationDto extends PartialType(
  OmitType(CreateAutomationDto, ['template'] as const),
) {}
