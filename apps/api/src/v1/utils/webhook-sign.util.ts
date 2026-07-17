import { createHmac, timingSafeEqual } from 'node:crypto';

export function buildSignatureHeader(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

export function verifySignatureHeader(
  header: string,
  rawBody: string,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  try {
    const parts = Object.fromEntries(
      header.split(',').map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim(), kv.slice(i + 1)];
      }),
    );
    const t = Number(parts.t);
    const v1 = typeof parts.v1 === 'string' ? parts.v1.trim().toLowerCase() : '';
    if (!Number.isFinite(t) || !v1) return false;
    if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;

    const expected = createHmac('sha256', secret)
      .update(`${t}.${rawBody}`)
      .digest('hex');
    if (expected.length !== v1.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch {
    return false;
  }
}
