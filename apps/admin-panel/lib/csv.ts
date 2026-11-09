/**
 * CSV cells for the Control Center's exports.
 *
 * Every text cell is quoted, and text starting with = + - @ (or a tab/CR) is
 * prefixed with an apostrophe, so a workspace named `=HYPERLINK(...)` opens as
 * text in a spreadsheet instead of executing (CSV formula injection).
 * Timestamps are ISO 8601 UTC, which no spreadsheet misreads.
 */
export function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '';
  }
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** A UTF-8 CSV download. The BOM makes Excel read non-ASCII names correctly. */
export function csvResponse(lines: string[], filename: string): Response {
  return new Response(`﻿${lines.join('\r\n')}\r\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
