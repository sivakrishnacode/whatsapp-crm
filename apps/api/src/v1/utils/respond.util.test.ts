import { describe, it, expect } from 'vitest';
import {
  ApiError,
  ok,
  okList,
  fail,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  rateLimited,
} from './respond.util';

// The public-API response envelope is a documented external contract
// (docs/public-api.md) — these tests pin the exact shapes.

describe('success envelopes', () => {
  it('ok wraps data', () => {
    expect(ok({ id: '1' })).toEqual({ data: { id: '1' } });
  });

  it('okList wraps items with snake_case next_cursor meta', () => {
    expect(okList([1, 2], 'abc')).toEqual({
      data: [1, 2],
      meta: { next_cursor: 'abc' },
    });
    expect(okList([], null)).toEqual({ data: [], meta: { next_cursor: null } });
  });
});

describe('ApiError envelope', () => {
  it('carries {error: {code, message}} as the response body', () => {
    const err = new ApiError('bad_request', 'nope', 400);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({
      error: { code: 'bad_request', message: 'nope' },
    });
    expect(err.code).toBe('bad_request');
  });

  it('fail throws the equivalent ApiError', () => {
    try {
      fail('meta_error', 'Meta said no', 502);
      expect.unreachable('fail() must throw');
    } catch (e) {
      const err = e as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.getStatus()).toBe(502);
      expect(err.code).toBe('meta_error');
    }
  });
});

describe('error helpers', () => {
  it('unauthorized → 401 with the documented default message', () => {
    const err = unauthorized();
    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: { code: 'unauthorized', message: 'Missing or invalid API key' },
    });
  });

  it('forbidden → 403, badRequest → 400, notFound → 404', () => {
    expect(forbidden('no scope').getStatus()).toBe(403);
    expect(forbidden('no scope').code).toBe('forbidden');
    expect(badRequest('bad').getStatus()).toBe(400);
    expect(badRequest('bad').code).toBe('bad_request');
    expect(notFound('gone').getStatus()).toBe(404);
    expect(notFound('gone').code).toBe('not_found');
  });
});

describe('rateLimited', () => {
  it('is a 429 with Retry-After and X-RateLimit-* headers', () => {
    const reset = Date.now() + 30_000;
    const err = rateLimited({ limit: 120, remaining: 0, reset });

    expect(err.getStatus()).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(err.headers).toBeDefined();
    expect(err.headers!['X-RateLimit-Limit']).toBe('120');
    expect(err.headers!['X-RateLimit-Remaining']).toBe('0');
    expect(err.headers!['X-RateLimit-Reset']).toBe(
      String(Math.ceil(reset / 1000)),
    );
    const retryAfter = Number(err.headers!['Retry-After']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(31);
  });

  it('clamps Retry-After to at least 1s when the window already reset', () => {
    const err = rateLimited({ limit: 120, remaining: 0, reset: Date.now() - 5000 });
    expect(err.headers!['Retry-After']).toBe('1');
  });
});
