import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WidgetKeyGuard } from './widget-key.guard';

const KEY = `wk_${'a'.repeat(40)}`;
const ALLOWED = ['https://example.com'];

function guardWith(
  config: {
    status?: string;
    allowedOrigins?: string[];
  } | null,
) {
  const service = {
    findByWidgetKey: vi.fn(() =>
      Promise.resolve(
        config === null
          ? null
          : {
              accountId: 'acc-1',
              userId: 'user-1',
              status: config.status ?? 'connected',
              allowedOrigins: config.allowedOrigins ?? ALLOWED,
            },
      ),
    ),
  };
  return new WidgetKeyGuard(service as never);
}

/** A minimal ExecutionContext carrying just the headers under test. */
function ctx(headers: Record<string, string | undefined>) {
  const request: Record<string, unknown> = {
    headers: { 'x-widget-key': KEY, ...headers },
    query: {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    request,
  } as never as { switchToHttp: () => { getRequest: () => never } } & {
    request: Record<string, unknown>;
  };
}

describe('WidgetKeyGuard — same-origin requests', () => {
  let guard: WidgetKeyGuard;
  beforeEach(() => {
    guard = guardWith({});
  });

  it('ADMITS a same-origin request with no Origin header', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR.
    //
    // The widget frame is served from the app origin and calls
    // /api/public/web/* on that same host. Per the Fetch spec browsers omit
    // `Origin` on same-origin GETs, so bootstrap, messages and the EventSource
    // stream all arrive without one. Denying that took the widget down
    // completely in production while POST /session — which DOES get an Origin
    // — kept working, making it look like a partial outage rather than a
    // guard bug.
    const c = ctx({ 'sec-fetch-site': 'same-origin' });
    await expect(guard.canActivate(c as never)).resolves.toBe(true);
  });

  it('admits a same-origin request even when the origin is not allowlisted', async () => {
    // The allowlist exists to stop OTHER sites embedding the widget. A call
    // from the frame to its own host is definitionally not that, so the app's
    // own origin never needs listing — otherwise every customer would have to
    // add our domain to their own allowlist.
    const c = ctx({
      'sec-fetch-site': 'same-origin',
      origin: 'https://app.converse360.in',
    });
    await expect(guard.canActivate(c as never)).resolves.toBe(true);
  });

  it('admits when Sec-Fetch-Site is absent (older Safari, non-browser client)', async () => {
    // Deliberate bounded loosening: a non-browser client can set any Origin it
    // likes, so refusing a missing one never protected against it. Volume abuse
    // is bounded by the per-(key, ip) rate limits, not here.
    await expect(guard.canActivate(ctx({}) as never)).resolves.toBe(true);
  });
});

describe('WidgetKeyGuard — cross-origin requests', () => {
  it('admits an allowlisted cross-site origin', async () => {
    const guard = guardWith({});
    const c = ctx({
      'sec-fetch-site': 'cross-site',
      origin: 'https://example.com',
    });
    await expect(guard.canActivate(c as never)).resolves.toBe(true);
  });

  it('REFUSES a cross-site origin that is not allowlisted', async () => {
    const guard = guardWith({});
    const c = ctx({
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example',
    });
    await expect(guard.canActivate(c as never)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses a lookalike domain', async () => {
    const guard = guardWith({});
    const c = ctx({
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil-example.com',
    });
    await expect(guard.canActivate(c as never)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses a browser that claims cross-site but sends no Origin', async () => {
    // Not a shape `fetch()` produces — a genuine cross-site fetch always
    // carries an Origin. Refused rather than falling through to the
    // missing-header allowance.
    const guard = guardWith({});
    const c = ctx({ 'sec-fetch-site': 'cross-site' });
    await expect(guard.canActivate(c as never)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses everything when the allowlist is empty', async () => {
    const guard = guardWith({ allowedOrigins: [] });
    const c = ctx({
      'sec-fetch-site': 'cross-site',
      origin: 'https://example.com',
    });
    await expect(guard.canActivate(c as never)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('WidgetKeyGuard — key and status', () => {
  it('refuses a malformed key without touching the database', async () => {
    const service = { findByWidgetKey: vi.fn() };
    const guard = new WidgetKeyGuard(service as never);
    const c = ctx({ 'x-widget-key': 'nope' });
    await expect(guard.canActivate(c as never)).rejects.toThrow(
      ForbiddenException,
    );
    expect(service.findByWidgetKey).not.toHaveBeenCalled();
  });

  it('gives an unknown key the same answer as a malformed one', async () => {
    // So an attacker cannot distinguish "this key exists" from "it does not"
    // and enumerate accounts.
    const guard = guardWith(null);
    await expect(
      guard.canActivate(ctx({ 'sec-fetch-site': 'same-origin' }) as never),
    ).rejects.toThrow('Unknown widget.');
  });

  it('refuses a disabled widget', async () => {
    const guard = guardWith({ status: 'disabled' });
    await expect(
      guard.canActivate(ctx({ 'sec-fetch-site': 'same-origin' }) as never),
    ).rejects.toThrow(/turned off/);
  });
});
