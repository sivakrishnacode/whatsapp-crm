import { AiError } from './types';
import { htmlToText } from './crawl';

/**
 * ============================================================
 * Uploaded file → knowledge-base text.
 *
 * PDF and DOCX go through real parsers (`pdf-parse`, which wraps pdf.js,
 * and `mammoth`) rather than a homegrown byte scraper: a PDF's text is
 * behind font encodings and compressed streams, and getting it subtly
 * wrong produces plausible-looking garbage that then gets embedded and
 * quoted to customers as fact. Both are required lazily so a Nest boot
 * never pays for pdf.js on an install that has no PDFs.
 *
 * Everything else is decoded as UTF-8 text. CSV gets a light pass that
 * pairs the header row with each row's values, because
 * `sku,price\nA-1,499` embeds far worse than `sku: A-1 | price: 499`.
 * ============================================================
 */

const MAX_EXTRACTED_CHARS = 200_000;

export const SUPPORTED_UPLOAD_EXTENSIONS = [
  'pdf',
  'docx',
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'html',
  'htm',
  'xml',
] as const;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface ExtractedFile {
  text: string;
  /** True when the source was longer than we keep. */
  truncated: boolean;
}

function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match ? match[1].toLowerCase() : '';
}

function decodeUtf8(bytes: Buffer): string {
  // Strip a UTF-8 BOM — Excel writes one into CSV exports and it shows
  // up as a stray glyph in the first header cell otherwise.
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Split one CSV line, honouring double-quoted fields with commas inside. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out;
}

/**
 * Turn tabular data into one labelled block per row.
 * A price list or FAQ sheet retrieves far better this way: each chunk
 * carries its own column names instead of depending on a header row that
 * chunking may have left behind.
 */
export function csvToText(raw: string, delimiter = ','): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  const header = splitCsvLine(lines[0], delimiter);
  const looksLikeHeader =
    header.length > 1 && header.every((h) => h.length > 0 && !/^-?\d+(\.\d+)?$/.test(h));

  if (!looksLikeHeader) return lines.join('\n');

  const rows: string[] = [];
  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line, delimiter);
    const pairs = header
      .map((key, i) => {
        const value = values[i];
        return value ? `${key}: ${value}` : null;
      })
      .filter(Boolean);
    if (pairs.length > 0) rows.push(pairs.join(' | '));
  }

  return rows.length > 0 ? rows.join('\n\n') : lines.join('\n');
}

/** Pretty-print JSON so chunking has line breaks to work with. */
function jsonToText(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Not valid JSON — keep it as text rather than rejecting the upload.
    return raw;
  }
}

async function extractPdf(bytes: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require('pdf-parse') as typeof import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    return result.text ?? '';
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractDocx(bytes: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require('mammoth') as typeof import('mammoth');
  const result = await mammoth.extractRawText({ buffer: bytes });
  return result.value ?? '';
}

/**
 * Extract text from an uploaded file.
 * Throws `AiError` for an unsupported type, an oversized file, or a file
 * that yielded no text (a scanned PDF is the usual culprit — saying so
 * beats silently storing an empty document).
 */
export async function extractFileText(args: {
  fileName: string;
  bytes: Buffer;
}): Promise<ExtractedFile> {
  const { fileName, bytes } = args;
  const ext = extensionOf(fileName);

  if (bytes.byteLength === 0) {
    throw new AiError('That file is empty.', {
      code: 'upload_empty',
      status: 400,
    });
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new AiError(
      `That file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      { code: 'upload_too_large', status: 400 },
    );
  }
  if (!SUPPORTED_UPLOAD_EXTENSIONS.includes(ext as never)) {
    throw new AiError(
      `Cannot read .${ext || 'unknown'} files. Supported: ${SUPPORTED_UPLOAD_EXTENSIONS.join(', ')}. (For .doc, save it as .docx first.)`,
      { code: 'upload_unsupported', status: 400 },
    );
  }

  let text: string;
  try {
    switch (ext) {
      case 'pdf':
        text = await extractPdf(bytes);
        break;
      case 'docx':
        text = await extractDocx(bytes);
        break;
      case 'csv':
        text = csvToText(decodeUtf8(bytes), ',');
        break;
      case 'tsv':
        text = csvToText(decodeUtf8(bytes), '\t');
        break;
      case 'json':
        text = jsonToText(decodeUtf8(bytes));
        break;
      case 'html':
      case 'htm':
        text = htmlToText(decodeUtf8(bytes));
        break;
      default:
        text = decodeUtf8(bytes);
    }
  } catch (err) {
    if (err instanceof AiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AiError(`Could not read that file: ${message}`, {
      code: 'upload_unreadable',
      status: 400,
    });
  }

  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (normalized.replace(/\s/g, '').length < 20) {
    throw new AiError(
      ext === 'pdf'
        ? 'No text found in that PDF — it looks like scanned images. Run it through OCR, or paste the text in.'
        : 'No readable text found in that file.',
      { code: 'upload_no_text', status: 400 },
    );
  }

  return {
    text: normalized.slice(0, MAX_EXTRACTED_CHARS),
    truncated: normalized.length > MAX_EXTRACTED_CHARS,
  };
}
