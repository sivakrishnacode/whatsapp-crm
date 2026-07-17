import { HttpException, HttpStatus } from '@nestjs/common';

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'bad_request'
  | 'not_found'
  | 'internal';

export class ApiError extends HttpException {
  readonly code: string;
  readonly headers?: Record<string, string>;

  constructor(
    code: string,
    message: string,
    status: number,
    headers?: Record<string, string>,
  ) {
    super(
      { error: { code, message } },
      status,
    );
    this.code = code;
    this.headers = headers;
  }
}

export function unauthorized(message = 'Missing or invalid API key'): ApiError {
  return new ApiError('unauthorized', message, HttpStatus.UNAUTHORIZED);
}

export function forbidden(message: string): ApiError {
  return new ApiError('forbidden', message, HttpStatus.FORBIDDEN);
}

export function badRequest(message: string): ApiError {
  return new ApiError('bad_request', message, HttpStatus.BAD_REQUEST);
}

export function notFound(message: string): ApiError {
  return new ApiError('not_found', message, HttpStatus.NOT_FOUND);
}

export interface RateLimitResult {
  limit: number;
  remaining: number;
  reset: number;
}

export function rateLimited(result: RateLimitResult): ApiError {
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return new ApiError(
    'rate_limited',
    'Rate limit exceeded for this API key',
    HttpStatus.TOO_MANY_REQUESTS,
    {
      'Retry-After': String(retryAfter),
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
    },
  );
}

export function ok<T>(data: T) {
  return { data };
}

export function okList<T>(items: T[], nextCursor: string | null) {
  return { data: items, meta: { next_cursor: nextCursor } };
}

export function fail(
  code: string,
  message: string,
  status: number,
  headers?: Record<string, string>,
): never {
  throw new ApiError(code, message, status, headers);
}
