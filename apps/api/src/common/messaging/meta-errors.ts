/**
 * Typed errors for any Meta Graph surface — WhatsApp Cloud API on
 * `graph.facebook.com` and the Instagram API on `graph.instagram.com`.
 *
 * Extracted from whatsapp/meta-api.util.ts (which re-exports these, so
 * existing imports are unaffected) when Instagram landed: both channels
 * hit Meta infrastructure, return the same error envelope, and need the
 * same branching. Background jobs in particular must distinguish "this
 * account's token died, skip it and warn" from "we're being throttled,
 * back off" from "something is actually broken".
 */

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

/** HTTP 401, or Meta error code 190 — access token expired/invalidated. */
export class MetaTokenExpiredError extends MetaApiError {
  constructor(message: string, code?: number, status?: number) {
    super(message, code, status);
    this.name = 'MetaTokenExpiredError';
  }
}

/** HTTP 429, or Meta throttling codes 4 / 80007 / 130429. */
export class MetaRateLimitError extends MetaApiError {
  constructor(message: string, code?: number, status?: number) {
    super(message, code, status);
    this.name = 'MetaRateLimitError';
  }
}

export const RATE_LIMIT_CODES = new Set([4, 80007, 130429]);

interface MetaErrorEnvelope {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    type?: string;
  };
}

/**
 * Parse a failed Meta response and throw the most specific error class
 * that fits, so callers can branch on the type rather than matching on
 * message strings.
 */
export async function throwClassifiedMetaError(
  response: Response,
  fallback: string,
): Promise<never> {
  let message = fallback;
  let code: number | undefined;
  try {
    const data = (await response.json()) as MetaErrorEnvelope;
    if (data.error?.message) message = data.error.message;
    code = data.error?.code;
  } catch {
    // response body wasn't JSON — keep the fallback
  }

  if (response.status === 401 || code === 190) {
    throw new MetaTokenExpiredError(message, code, response.status);
  }
  if (
    response.status === 429 ||
    (code !== undefined && RATE_LIMIT_CODES.has(code))
  ) {
    throw new MetaRateLimitError(message, code, response.status);
  }
  throw new MetaApiError(message, code, response.status);
}
