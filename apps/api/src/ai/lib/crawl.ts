import { AiError } from './types';
import { safeFetch } from './http-guard';

/**
 * ============================================================
 * "Crawl a page" — turn one URL into knowledge-base text.
 *
 * Deliberately ONE page, not a spider. A crawler that follows links
 * needs a queue, a politeness delay, robots.txt handling and a stop
 * condition; a business pasting its pricing page wants that page. Adding
 * "crawl my whole site" later means a job on the BullMQ queue calling
 * this function per URL — which is why it takes a URL and returns text,
 * with no persistence of its own.
 *
 * HTML is reduced with regexes rather than a DOM parser. That is a
 * deliberate trade: the output is knowledge-base prose fed to an LLM, so
 * imperfect whitespace costs nothing, and it keeps a parser dependency
 * (and its parse-time attack surface, on attacker-supplied markup) out
 * of the API.
 * ============================================================
 */

const MAX_PAGE_BYTES = 1_500_000;
const MAX_TEXT_CHARS = 120_000;

/** Elements whose text content is never page content. */
const DROPPED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'nav',
  'footer',
  'form',
];

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const num = Number(code);
      return num > 0 && num < 0x110000 ? String.fromCodePoint(num) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const num = Number.parseInt(code, 16);
      return num > 0 && num < 0x110000 ? String.fromCodePoint(num) : '';
    });
}

export function extractTitle(html: string): string {
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  if (og?.[1]?.trim()) return decodeEntities(og[1]).trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]?.trim()) return decodeEntities(title[1]).replace(/\s+/g, ' ').trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) {
    const text = decodeEntities(h1[1].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  return '';
}

/** Reduce an HTML document to readable text with paragraph breaks kept. */
export function htmlToText(html: string): string {
  let out = html;

  for (const tag of DROPPED_ELEMENTS) {
    out = out.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'),
      ' ',
    );
    // Unclosed/self-closing variants of the same elements.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }

  out = out.replace(/<!--[\s\S]*?-->/g, ' ');

  // Block-level elements become paragraph breaks so `chunkText` (which
  // splits on blank lines) gets sensible units instead of one long line.
  out = out
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|td|th)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '• ');

  out = out.replace(/<[^>]+>/g, ' ');
  out = decodeEntities(out);

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch one page and return its readable text.
 * Throws `AiError` when the URL is refused, unreachable, not HTML, or
 * carries no extractable text (a JS-only SPA shell is the common case —
 * and saying so is far more useful than storing an empty document).
 */
export async function crawlPage(rawUrl: string): Promise<CrawledPage> {
  const res = await safeFetch({
    url: rawUrl,
    method: 'GET',
    timeoutMs: 15_000,
    maxBytes: MAX_PAGE_BYTES,
    accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
  });

  if (res.status >= 400) {
    throw new AiError(
      `${res.url} returned HTTP ${res.status}. Check the link is public — the crawler is not signed in.`,
      { code: 'crawl_http_error', status: 400 },
    );
  }

  const contentType = res.contentType.toLowerCase();
  const isHtml = contentType.includes('html') || contentType === '';
  const isPlain = contentType.includes('text/plain') || contentType.includes('markdown');

  if (!isHtml && !isPlain) {
    throw new AiError(
      `${res.url} is ${contentType || 'an unknown type'}, not a web page. Upload it as a file instead.`,
      { code: 'crawl_not_html', status: 400 },
    );
  }

  const text = (isPlain ? res.body : htmlToText(res.body)).slice(0, MAX_TEXT_CHARS);
  const title = (isPlain ? '' : extractTitle(res.body)) || new URL(res.url).hostname;

  if (text.replace(/\s/g, '').length < 40) {
    throw new AiError(
      `Found almost no text on ${res.url}. If the page renders with JavaScript, copy the text in by hand instead.`,
      { code: 'crawl_empty', status: 400 },
    );
  }

  return {
    url: res.url,
    title: title.slice(0, 200),
    text,
    truncated: res.truncated || text.length >= MAX_TEXT_CHARS,
  };
}
