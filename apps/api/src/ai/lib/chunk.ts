const DEFAULT_MAX_CHARS = 1200;

export function chunkText(
  content: string,
  opts: { maxChars?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const text = content.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) {
        const slice = para.slice(i, i + maxChars).trim();
        if (slice) chunks.push(slice);
      }
      continue;
    }
    if (current && current.length + 2 + para.length > maxChars) flush();
    current = current ? `${current}\n\n${para}` : para;
  }
  flush();

  return chunks;
}
