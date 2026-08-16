/**
 * CSV export for the analytics pages.
 *
 * Exports the data ALREADY ON SCREEN rather than re-querying. That is
 * the whole point: the file matches the range and the filters the user
 * is looking at, so "export" never quietly returns a different dataset
 * from the one they just narrowed down.
 */

export interface CsvColumn<T> {
  header: string
  value: (row: T) => string | number | null | undefined
}

/**
 * RFC-4180 quoting. Every field is quoted rather than only the ones
 * that need it — the conditional version is where the bugs live, and
 * a quoted numeric column still parses as a number in every
 * spreadsheet.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""'
  return `"${String(value).replace(/"/g, '""')}"`
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => cell(c.header)).join(',')
  const body = rows.map((row) => columns.map((c) => cell(c.value(row))).join(','))
  return [head, ...body].join('\r\n')
}

/**
 * Join several tables into one file, each under its own title row.
 *
 * A single flat CSV cannot hold "daily volume" and "top templates" at
 * once, and shipping four separate downloads for one click is worse:
 * browsers block all but the first.
 */
export interface CsvSection {
  title: string
  csv: string
}

export function joinSections(sections: CsvSection[]): string {
  return sections
    .filter((s) => s.csv.trim().length > 0)
    .map((s) => `${cell(s.title)}\r\n${s.csv}`)
    .join('\r\n\r\n')
}

/**
 * Trigger a download. `﻿` is a UTF-8 BOM: without it Excel on
 * Windows renders a name like "Müller" as mojibake, which is the first
 * thing anybody notices about an export.
 */
export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** `whatsapp-analytics-2026-03-01-to-2026-03-31.csv` */
export function exportFilename(channel: string, startKey: string, endKey: string): string {
  return `${channel}-analytics-${startKey}-to-${endKey}.csv`
}
