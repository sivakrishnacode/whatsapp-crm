import { describe, expect, it } from 'vitest';

import { csvToText, extractFileText, splitCsvLine } from './extract';
import { htmlToText, extractTitle } from './crawl';
import { AiError } from './types';

describe('splitCsvLine', () => {
  it('honours quoted fields containing the delimiter', () => {
    expect(splitCsvLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes doubled quotes', () => {
    expect(splitCsvLine('a,"say ""hi""",c', ',')).toEqual(['a', 'say "hi"', 'c']);
  });
});

describe('csvToText', () => {
  it('labels each row with its header, so a chunk carries its own columns', () => {
    const text = csvToText('sku,price,stock\nA-1,499,12\nA-2,899,0');
    expect(text).toContain('sku: A-1 | price: 499 | stock: 12');
    expect(text).toContain('sku: A-2 | price: 899');
    // Blank line between rows so chunkText splits on row boundaries.
    expect(text).toContain('\n\n');
  });

  it('leaves headerless numeric data alone', () => {
    const text = csvToText('1,2,3\n4,5,6');
    expect(text).toBe('1,2,3\n4,5,6');
  });

  it('handles tabs', () => {
    expect(csvToText('name\tqty\nBeans\t3', '\t')).toContain('name: Beans | qty: 3');
  });
});

describe('htmlToText', () => {
  it('drops script, style and nav content', () => {
    const html = `
      <html><head><style>.a{color:red}</style><script>alert('x')</script></head>
      <body><nav>Home About</nav><h1>Refund policy</h1>
      <p>Returns within 14 days.</p><footer>© Acme</footer></body></html>`;
    const text = htmlToText(html);

    expect(text).toContain('Refund policy');
    expect(text).toContain('Returns within 14 days.');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('Home About');
    expect(text).not.toContain('© Acme');
  });

  it('turns block elements into paragraph breaks and decodes entities', () => {
    const text = htmlToText('<p>One&nbsp;&amp;&nbsp;two</p><p>Three</p>');
    expect(text).toBe('One & two\n\nThree');
  });

  it('keeps list items readable', () => {
    expect(htmlToText('<ul><li>First</li><li>Second</li></ul>')).toContain('• First');
  });
});

describe('extractTitle', () => {
  it('prefers og:title, then <title>, then <h1>', () => {
    expect(
      extractTitle('<meta property="og:title" content="OG name"><title>Tab</title>'),
    ).toBe('OG name');
    expect(extractTitle('<title>Tab  name</title>')).toBe('Tab name');
    expect(extractTitle('<h1><span>Heading</span></h1>')).toBe('Heading');
    expect(extractTitle('<p>nothing</p>')).toBe('');
  });
});

describe('extractFileText', () => {
  it('reads plain text and markdown', async () => {
    const result = await extractFileText({
      fileName: 'policy.txt',
      bytes: Buffer.from('Returns are accepted within 14 days of delivery.'),
    });
    expect(result.text).toContain('within 14 days');
  });

  it('strips a UTF-8 BOM from CSV', async () => {
    const result = await extractFileText({
      fileName: 'prices.csv',
      bytes: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('sku,price\nA-1,499\nA-2,899'),
      ]),
    });
    expect(result.text.startsWith('sku')).toBe(true);
  });

  it('rejects an unsupported extension with the supported list', async () => {
    await expect(
      extractFileText({ fileName: 'notes.doc', bytes: Buffer.from('x'.repeat(100)) }),
    ).rejects.toMatchObject({ code: 'upload_unsupported' });
  });

  it('rejects an empty file', async () => {
    await expect(
      extractFileText({ fileName: 'empty.txt', bytes: Buffer.alloc(0) }),
    ).rejects.toBeInstanceOf(AiError);
  });

  it('rejects a file with no meaningful text', async () => {
    await expect(
      extractFileText({ fileName: 'tiny.txt', bytes: Buffer.from('   \n  ') }),
    ).rejects.toMatchObject({ code: 'upload_no_text' });
  });

  it('pretty-prints JSON so chunking has line breaks', async () => {
    const result = await extractFileText({
      fileName: 'faq.json',
      bytes: Buffer.from(
        JSON.stringify({ question: 'Do you deliver to Chennai?', answer: 'Yes, in 2 days.' }),
      ),
    });
    expect(result.text).toContain('\n');
    expect(result.text).toContain('Chennai');
  });
});
