export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface Cursor {
  createdAt: string;
  id: string;
}

export interface ListParams {
  limit: number;
  cursor: Cursor | null;
}

export function parseListParams(query: { limit?: unknown; cursor?: unknown }): ListParams {
  const rawLimit = Number(query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const rawCursor = typeof query.cursor === 'string' ? query.cursor : null;
  return { limit, cursor: decodeCursor(rawCursor) };
}

export function encodeCursor(row: { created_at: Date | string | null; id: string }): string {
  const dateVal = row.created_at instanceof Date ? row.created_at : new Date(row.created_at ?? Date.now());
  return Buffer.from(`${dateVal.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep === -1) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!UUID_RE.test(id)) return null;
    const ts = Date.parse(createdAt);
    if (Number.isNaN(ts)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function getKeysetWhereClause(cursor: Cursor | null) {
  if (!cursor) return {};
  return {
    OR: [
      {
        created_at: {
          lt: new Date(cursor.createdAt),
        },
      },
      {
        created_at: new Date(cursor.createdAt),
        id: {
          lt: cursor.id,
        },
      },
    ],
  };
}

export function buildPage<T extends { created_at: Date | string | null; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeCursor(items[items.length - 1]) };
}
