import type { Prisma } from '@prisma/client';

/**
 * Widen a plain JSON-shaped value into Prisma's `InputJsonValue`.
 *
 * Needed because Prisma models a JSON array as `InputJsonValue[]`, whose
 * members must be structurally assignable to `InputJsonObject` — an
 * index signature. Our Graph response types are precise interfaces
 * (`MetaActionRow` has `action_type` and `value`, not `[k: string]`), so
 * they are *narrower* than what Prisma asks for and TypeScript refuses
 * the direct cast even though every value really is JSON.
 *
 * One helper with the reasoning written down, rather than an
 * `as unknown as Prisma.InputJsonValue` at each of the dozen call sites
 * where the same thing is true. The `undefined` passthrough matters:
 * Prisma treats `undefined` as "leave this column alone" and `null` as
 * "write SQL NULL", and those are different intentions.
 */
export function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return value as Prisma.InputJsonValue;
}

/**
 * As `toJson`, but for a column that should be written as `{}` rather
 * than left alone when there is nothing — `targeting` and `creative` are
 * NOT NULL with a `'{}'` default, so a missing value still needs a value.
 */
export function toJsonObject(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  return value as Prisma.InputJsonValue;
}
