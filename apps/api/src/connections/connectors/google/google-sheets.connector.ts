import { BadRequestException } from '@nestjs/common';
import type { Connector, ResourceOption } from '../../connections.types';
import { googleRequest } from '../../utils/google-api.util';
import { GOOGLE_PROVIDER, GOOGLE_SCOPES } from './google.oauth';
import { asText } from '../../utils/value.util';

/**
 * Google Sheets.
 *
 * WHY YOU PASTE A LINK INSTEAD OF PICKING FROM A LIST
 *   Listing somebody's spreadsheets means the Drive API, and every Drive
 *   scope wide enough to enumerate files is RESTRICTED — which would put
 *   this whole project on the annual CASA assessment track for the sake
 *   of one dropdown. So the spreadsheet arrives as a URL (or a bare id),
 *   and the TABS inside it are then listed through the Sheets API, which
 *   `spreadsheets` already covers. In practice that is the dropdown
 *   people wanted: nobody misremembers which sheet they meant, they
 *   misremember whether the tab is "Leads" or "leads".
 */

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * Accept anything that identifies a spreadsheet.
 *
 * Authors paste the browser URL, because that is what is in front of
 * them. Requiring the bare id means a step that fails with "not found"
 * on a value that looks perfectly correct.
 */
export function parseSpreadsheetId(raw: unknown): string {
  const value = asText(raw).trim();
  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(value);
  if (fromUrl) return fromUrl[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(value)) return value;
  throw new BadRequestException(
    'That does not look like a Google Sheets link or id. Paste the URL from your browser.',
  );
}

/**
 * A1 notation needs quoting when a tab name contains a space or a quote,
 * and Sheets fails obscurely when it is missing — "Unable to parse range"
 * against a tab that plainly exists.
 */
function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

interface ValuesResponse {
  values?: string[][];
}

/** The header row, which is what every action addresses columns by. */
async function readHeaders(args: {
  accessToken: string;
  spreadsheetId: string;
  tab: string;
}): Promise<string[]> {
  const res = await googleRequest<ValuesResponse>({
    url: `${SHEETS_BASE}/${args.spreadsheetId}/values/${encodeURIComponent(`${quoteTab(args.tab)}!1:1`)}`,
    accessToken: args.accessToken,
  });
  return res.values?.[0] ?? [];
}

/**
 * Turn {column name: value} into a positional row.
 *
 * Authors think in column names; Sheets thinks in positions. Doing this
 * mapping here means inserting a column in the spreadsheet does not
 * silently start writing values into the wrong fields — which is exactly
 * what a positional-only API does, with no error.
 */
function rowFromValues(
  headers: string[],
  values: Record<string, unknown>,
): unknown[] {
  if (headers.length === 0) {
    // No header row: fall back to the order the author typed. Better
    // than refusing — plenty of sheets are just data.
    return Object.values(values);
  }
  const lowered = headers.map((h) => h.trim().toLowerCase());
  const row: unknown[] = new Array(headers.length).fill('');
  for (const [key, value] of Object.entries(values)) {
    const index = lowered.indexOf(key.trim().toLowerCase());
    if (index >= 0) row[index] = value ?? '';
    else row.push(value ?? ''); // unknown column — append rather than lose it
  }
  return row;
}

export const googleSheetsConnector: Connector = {
  provider: GOOGLE_PROVIDER,
  app: 'google_sheets',
  name: 'Google Sheets',
  blurb: 'Append, update and look up rows in a spreadsheet',
  monogram: 'GS',
  hue: 'oklch(0.62 0.15 150)',

  resources: {
    /** Tabs in one spreadsheet. Needs `spreadsheet` to be filled first. */
    async tabs({ accessToken, input }): Promise<ResourceOption[]> {
      const raw = input.spreadsheet;
      if (!raw) return [];
      const spreadsheetId = parseSpreadsheetId(raw);
      const meta = await googleRequest<{
        sheets?: { properties?: { title?: string } }[];
      }>({
        url: `${SHEETS_BASE}/${spreadsheetId}`,
        accessToken,
        query: { fields: 'sheets.properties.title' },
      });
      return (meta.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((t): t is string => Boolean(t))
        .map((title) => ({ value: title, label: title }));
    },
  },

  actions: [
    {
      id: 'append_row',
      label: 'Append row',
      description: 'Add a row to the bottom of a sheet',
      scopes: [GOOGLE_SCOPES.sheets],
      outputs: ['updated_range', 'row_number'],
      inputs: [
        {
          key: 'spreadsheet',
          label: 'Spreadsheet',
          kind: 'text',
          required: true,
          tokens: false,
          placeholder: 'https://docs.google.com/spreadsheets/d/...',
          help: 'Paste the link from your browser. We cannot list your files — that needs a Google permission this app deliberately does not ask for.',
        },
        {
          key: 'tab',
          label: 'Tab',
          kind: 'resource_select',
          resource: 'tabs',
          dependsOn: ['spreadsheet'],
          required: true,
          tokens: false,
        },
        {
          key: 'values',
          label: 'Values',
          kind: 'key_values',
          required: true,
          tokens: true,
          help: 'Keys are column headings from row 1. Values can use {{ tokens }}.',
        },
      ],
      async execute({ input, accessToken }) {
        const spreadsheetId = parseSpreadsheetId(input.spreadsheet);
        const tab = asText(input.tab);
        const headers = await readHeaders({ accessToken, spreadsheetId, tab });
        const row = rowFromValues(
          headers,
          input.values as Record<string, unknown>,
        );

        const res = await googleRequest<{
          updates?: { updatedRange?: string };
        }>({
          url: `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(quoteTab(tab))}:append`,
          accessToken,
          method: 'POST',
          query: {
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
          },
          body: { values: [row] },
        });

        const updatedRange = res.updates?.updatedRange ?? '';
        const rowNumber = Number(/!\D+(\d+)/.exec(updatedRange)?.[1] ?? 0);
        return {
          output: { updated_range: updatedRange, row_number: rowNumber },
          detail: `Appended row ${rowNumber || '?'} to ${tab}`,
        };
      },
    },

    {
      id: 'find_row',
      label: 'Find row',
      description: 'Look up a row by a column value',
      scopes: [GOOGLE_SCOPES.sheets],
      outputs: ['found', 'row', 'row_number'],
      inputs: [
        {
          key: 'spreadsheet',
          label: 'Spreadsheet',
          kind: 'text',
          required: true,
          tokens: false,
          placeholder: 'https://docs.google.com/spreadsheets/d/...',
        },
        {
          key: 'tab',
          label: 'Tab',
          kind: 'resource_select',
          resource: 'tabs',
          dependsOn: ['spreadsheet'],
          required: true,
          tokens: false,
        },
        {
          key: 'match_column',
          label: 'Search column',
          kind: 'text',
          required: true,
          tokens: false,
          placeholder: 'Phone',
          help: 'A heading from row 1.',
        },
        {
          key: 'match_value',
          label: 'Search for',
          kind: 'text',
          required: true,
          tokens: true,
          placeholder: '{{ contact.phone }}',
        },
      ],
      async execute({ input, accessToken }) {
        const spreadsheetId = parseSpreadsheetId(input.spreadsheet);
        const tab = asText(input.tab);
        const { headers, rows } = await readSheet({
          accessToken,
          spreadsheetId,
          tab,
        });
        const index = headerIndex(headers, asText(input.match_column));
        const needle = asText(input.match_value).trim().toLowerCase();

        for (let i = 0; i < rows.length; i++) {
          if ((rows[i][index] ?? '').trim().toLowerCase() === needle) {
            return {
              output: {
                found: true,
                row: asObject(headers, rows[i]),
                // +2: row 1 is the header, and sheets count from 1.
                row_number: i + 2,
              },
              detail: `Found in row ${i + 2}`,
            };
          }
        }

        // NOT an error. "Is this customer already in the sheet?" has two
        // valid answers, and a condition step branches on `found` — the
        // same reasoning as ignore_http_errors on the HTTP step.
        return {
          output: { found: false, row: null, row_number: 0 },
          detail: 'No matching row',
        };
      },
    },

    {
      id: 'update_row',
      label: 'Update row',
      description: 'Change the first row whose column matches a value',
      scopes: [GOOGLE_SCOPES.sheets],
      outputs: ['updated', 'row_number', 'updated_range'],
      inputs: [
        {
          key: 'spreadsheet',
          label: 'Spreadsheet',
          kind: 'text',
          required: true,
          tokens: false,
          placeholder: 'https://docs.google.com/spreadsheets/d/...',
        },
        {
          key: 'tab',
          label: 'Tab',
          kind: 'resource_select',
          resource: 'tabs',
          dependsOn: ['spreadsheet'],
          required: true,
          tokens: false,
        },
        {
          key: 'match_column',
          label: 'Search column',
          kind: 'text',
          required: true,
          tokens: false,
          placeholder: 'Phone',
        },
        {
          key: 'match_value',
          label: 'Search for',
          kind: 'text',
          required: true,
          tokens: true,
          placeholder: '{{ contact.phone }}',
        },
        {
          key: 'values',
          label: 'New values',
          kind: 'key_values',
          required: true,
          tokens: true,
          help: 'Only the columns you list are changed; the rest of the row is left alone.',
        },
      ],
      async execute({ input, accessToken }) {
        const spreadsheetId = parseSpreadsheetId(input.spreadsheet);
        const tab = asText(input.tab);
        const { headers, rows } = await readSheet({
          accessToken,
          spreadsheetId,
          tab,
        });
        const index = headerIndex(headers, asText(input.match_column));
        const needle = asText(input.match_value).trim().toLowerCase();

        const found = rows.findIndex(
          (row) => (row[index] ?? '').trim().toLowerCase() === needle,
        );
        if (found < 0) {
          return {
            output: { updated: false, row_number: 0, updated_range: '' },
            detail: 'No matching row to update',
          };
        }

        // Merge over the EXISTING row rather than writing a fresh one:
        // a bare write of the named columns would blank every other cell
        // in the row, which is a silent data loss the author never asked
        // for.
        const merged = [...rows[found]];
        while (merged.length < headers.length) merged.push('');
        for (const [key, value] of Object.entries(
          input.values as Record<string, unknown>,
        )) {
          const at = headers.findIndex(
            (h) => h.trim().toLowerCase() === key.trim().toLowerCase(),
          );
          if (at >= 0) merged[at] = asText(value);
        }

        const rowNumber = found + 2;
        const res = await googleRequest<{ updatedRange?: string }>({
          url: `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(`${quoteTab(tab)}!A${rowNumber}`)}`,
          accessToken,
          method: 'PUT',
          query: { valueInputOption: 'USER_ENTERED' },
          body: { values: [merged] },
        });

        return {
          output: {
            updated: true,
            row_number: rowNumber,
            updated_range: res.updatedRange ?? '',
          },
          detail: `Updated row ${rowNumber} in ${tab}`,
        };
      },
    },

    {
      id: 'create_spreadsheet',
      label: 'Create spreadsheet',
      description: 'Make a new spreadsheet with a header row',
      scopes: [GOOGLE_SCOPES.sheets],
      outputs: ['spreadsheet_id', 'url'],
      inputs: [
        {
          key: 'title',
          label: 'Title',
          kind: 'text',
          required: true,
          tokens: true,
          placeholder: 'Leads {{ now.date }}',
        },
        {
          key: 'headers',
          label: 'Column headings',
          kind: 'text',
          required: false,
          tokens: false,
          placeholder: 'Name, Phone, Email',
          help: 'Comma separated. Written as row 1.',
        },
      ],
      async execute({ input, accessToken }) {
        const created = await googleRequest<{
          spreadsheetId?: string;
          spreadsheetUrl?: string;
        }>({
          url: SHEETS_BASE,
          accessToken,
          method: 'POST',
          body: { properties: { title: asText(input.title) } },
        });

        const spreadsheetId = created.spreadsheetId;
        if (!spreadsheetId) {
          throw new BadRequestException(
            'Google did not return a spreadsheet id.',
          );
        }

        const headers = asText(input.headers)
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean);

        if (headers.length > 0) {
          await googleRequest({
            url: `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent('A1')}`,
            accessToken,
            method: 'PUT',
            query: { valueInputOption: 'USER_ENTERED' },
            body: { values: [headers] },
          });
        }

        return {
          output: {
            spreadsheet_id: spreadsheetId,
            url:
              created.spreadsheetUrl ??
              `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
          },
          detail: `Created "${asText(input.title)}"`,
        };
      },
    },
  ],
};

async function readSheet(args: {
  accessToken: string;
  spreadsheetId: string;
  tab: string;
}): Promise<{ headers: string[]; rows: string[][] }> {
  const res = await googleRequest<ValuesResponse>({
    url: `${SHEETS_BASE}/${args.spreadsheetId}/values/${encodeURIComponent(quoteTab(args.tab))}`,
    accessToken: args.accessToken,
  });
  const [headers = [], ...rows] = res.values ?? [];
  return { headers, rows };
}

function headerIndex(headers: string[], column: string): number {
  const at = headers.findIndex(
    (h) => h.trim().toLowerCase() === column.trim().toLowerCase(),
  );
  if (at < 0) {
    throw new BadRequestException(
      `There is no "${column}" column. Row 1 has: ${headers.join(', ') || '(empty)'}`,
    );
  }
  return at;
}

function asObject(headers: string[], row: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((header, i) => {
    out[header] = row[i] ?? '';
  });
  return out;
}
