import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoogleScriptConnectionService } from './services/google-script-connection.service';
import {
  GoogleScriptError,
  GoogleScriptExecutorService,
} from './services/google-script-executor.service';
import { GOOGLE_SCRIPT_ACTIONS } from './google-script.catalog';
import { BRIDGE_MANIFEST, renderBridgeSource } from './bridge-source';

/**
 * What is worth pinning here is the handful of behaviours whose failure is
 * expensive or, worse, MISDIAGNOSED — this module already produced one
 * error message that sent a developer hunting for a Google setting when
 * the real cause was a stale secret.
 *
 *   * the 302 is followed as a **GET** — replaying the POST fetches
 *     Google's Drive error page, which looks exactly like a broken script
 *   * the redirect target is pinned to Apps Script's own hosts
 *   * the secret never appears in a thrown error
 *   * a `/dev` URL is refused at paste time rather than at 3am
 *   * the catalogue stays free of restricted scopes and of `create_meet`
 */

const EXEC = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const ECHO = 'https://script.googleusercontent.com/macros/echo?user_content_key=k';
const SECRET = 'a'.repeat(64);

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A connection service stub — the executor only ever asks it three things. */
function stubConnections(creds: { execUrl: string; secret: string } | null) {
  return {
    resolveCredentials: vi.fn().mockResolvedValue(creds),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
  } as unknown as GoogleScriptConnectionService;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleScriptExecutorService', () => {
  it('follows the 302 as a GET and publishes the body as output', async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method, body: init.body });
      return calls.length === 1
        ? redirect(ECHO)
        : json({ ok: true, action: 'check_availability', busy: [{ start: 'a', end: 'b' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const executor = new GoogleScriptExecutorService(
      stubConnections({ execUrl: EXEC, secret: SECRET }),
    );
    const result = await executor.run('acc-1', 'check_availability', {
      from: '2026-08-19T00:00:00Z',
      to: '2026-08-20T00:00:00Z',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('POST');
    // ⚠️ The whole point. A POST replayed here fetches an HTML error page
    // from googleusercontent, which the executor then reports as "the
    // script returned a web page" — a real misdiagnosis this pins shut.
    expect(calls[1].method).toBe('GET');
    expect(calls[1].url).toBe(ECHO);
    expect(calls[1].body).toBeUndefined();

    // `ok` and `action` are protocol; only the result reaches the context.
    expect(result.output).toEqual({ busy: [{ start: 'a', end: 'b' }] });
    expect(result.output.ok).toBeUndefined();
  });

  it('sends the secret and action in the POST body, never in the URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect(ECHO))
      .mockResolvedValueOnce(json({ ok: true, row: 4 }));
    vi.stubGlobal('fetch', fetchMock);

    const executor = new GoogleScriptExecutorService(
      stubConnections({ execUrl: EXEC, secret: SECRET }),
    );
    await executor.run('acc-1', 'sheet_append', {
      spreadsheet_id: 'sheet-1',
      values: ['a', 'b'],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXEC);
    expect(url).not.toContain(SECRET);
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.secret).toBe(SECRET);
    expect(sent.action).toBe('sheet_append');
    expect(sent.spreadsheet_id).toBe('sheet-1');
  });

  it('refuses a redirect off Apps Script and does not follow it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect('https://evil.test/collect'));
    vi.stubGlobal('fetch', fetchMock);

    const executor = new GoogleScriptExecutorService(
      stubConnections({ execUrl: EXEC, secret: SECRET }),
    );
    await expect(
      executor.run('acc-1', 'check_availability', { from: 'a', to: 'b' }),
    ).rejects.toThrow(/somewhere unexpected \(evil\.test\)/);

    // One call: the hop was never made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('translates the script\'s "unauthorized" into the actual cause', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(redirect(ECHO))
        .mockResolvedValueOnce(json({ ok: false, error: 'unauthorized' })),
    );

    const executor = new GoogleScriptExecutorService(
      stubConnections({ execUrl: EXEC, secret: SECRET }),
    );
    const err = await executor
      .run('acc-1', 'check_availability', { from: 'a', to: 'b' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GoogleScriptError);
    // The bridge is deliberately vague; the workspace is allowed to know.
    expect((err as Error).message).toMatch(/rejected our secret/);
    expect((err as Error).message).toMatch(/regenerate/i);
    // ⚠️ and the secret itself must not ride along in the message, which
    // is written to `last_error` and rendered in the browser.
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('reads an HTML reply as the access setting, not as a script bug', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(redirect(ECHO))
        .mockResolvedValueOnce(
          new Response('<!DOCTYPE html><html><body>Sign in</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
    );

    const executor = new GoogleScriptExecutorService(
      stubConnections({ execUrl: EXEC, secret: SECRET }),
    );
    await expect(
      executor.run('acc-1', 'check_availability', { from: 'a', to: 'b' }),
    ).rejects.toThrow(/Who has access/);
  });

  it('says Google is not connected rather than calling nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const executor = new GoogleScriptExecutorService(stubConnections(null));
    await expect(
      executor.run('acc-1', 'check_availability', { from: 'a', to: 'b' }),
    ).rejects.toThrow(/not connected/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks required fields before spending a call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const executor = new GoogleScriptExecutorService(
      stubConnections({ execUrl: EXEC, secret: SECRET }),
    );
    await expect(executor.run('acc-1', 'send_email', { to: 'a@b.test' })).rejects.toThrow(
      /needs: Subject, Message/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('normaliseExecUrl', () => {
  const norm = (u: string) => GoogleScriptConnectionService.normaliseExecUrl(u);

  it('accepts an /exec URL and drops any query', () => {
    expect(norm(`  ${EXEC}?x=1#frag `)).toBe(EXEC);
  });

  it('refuses the /dev URL by name', () => {
    // It sits next to /exec in the Apps Script UI, needs a signed-in
    // browser, and would fail every automation with a login page.
    expect(() => norm(EXEC.replace('/exec', '/dev'))).toThrow(/\/dev URL/);
  });

  it('refuses a host that is not script.google.com', () => {
    // Our server POSTs a secret to whatever this says. A generic
    // "publicly routable" check would happily accept a collector.
    expect(() => norm('https://evil.test/macros/s/x/exec')).toThrow(
      /must be on script\.google\.com/,
    );
  });

  it('refuses plain http', () => {
    expect(() => norm(EXEC.replace('https:', 'http:'))).toThrow(/must be https/);
  });

  it('mints a 64-character hex secret', () => {
    const secret = GoogleScriptConnectionService.generateSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toBe(GoogleScriptConnectionService.generateSecret());
  });
});

describe('the catalogue and the script it is a contract with', () => {
  it('names every action in the served script', () => {
    const source = renderBridgeSource(SECRET);
    for (const action of GOOGLE_SCRIPT_ACTIONS) {
      // A catalogue entry with no handler is an "unknown action" at run
      // time, against a script we cannot update.
      expect(source).toContain(`case '${action.id}':`);
    }
  });

  it('puts the secret in the script and leaves no placeholder', () => {
    const source = renderBridgeSource(SECRET);
    expect(source).toContain(`const SECRET = '${SECRET}'`);
    expect(source).not.toContain('__CONVERSE360_SECRET__');
    expect(source).not.toContain('__BRIDGE_VERSION__');
  });

  it('carries no Converse360 credential into the customer\'s account', () => {
    const source = renderBridgeSource(SECRET);
    // The executor follows the redirect and reads the reply, so the script
    // never calls home — and therefore holds nothing that could act on the
    // workspace. Reintroducing a callback would undo that.
    expect(source).not.toMatch(/converse360_live_/);
    expect(source).not.toMatch(/api\/v1/);
  });

  it('requests no restricted Google scope', () => {
    // Any one of these turns a one-off review into a paid annual CASA
    // assessment — and asking for it inside a customer's own script does
    // not make it cheaper, only less visible.
    const restricted = [
      'gmail.readonly',
      'gmail.compose',
      'gmail.modify',
      'gmail.metadata',
      'mail.google.com',
      'auth/drive',
    ];
    for (const scope of restricted) {
      expect(BRIDGE_MANIFEST).not.toContain(scope);
    }
    expect(BRIDGE_MANIFEST).toContain('auth/gmail.send');
  });

  it('deploys as ANYONE_ANONYMOUS executing as the deploying user', () => {
    // "Anyone with a Google account" returns a login page to our server;
    // pre-setting it in the manifest is what stops that being chosen.
    const manifest = JSON.parse(BRIDGE_MANIFEST) as {
      webapp: { access: string; executeAs: string };
    };
    expect(manifest.webapp.access).toBe('ANYONE_ANONYMOUS');
    expect(manifest.webapp.executeAs).toBe('USER_DEPLOYING');
  });

  it('has no create_meet action', () => {
    // Verified against a live deployment: a standalone Meet space needs
    // the Meet API on a GCP project an Apps Script default project cannot
    // enable. create_event with add_meet returns a real link instead.
    expect(GOOGLE_SCRIPT_ACTIONS.find((a) => a.id === 'create_meet')).toBeUndefined();
    const createEvent = GOOGLE_SCRIPT_ACTIONS.find((a) => a.id === 'create_event');
    expect(createEvent?.inputs.some((f) => f.key === 'add_meet')).toBe(true);
    expect(createEvent?.outputs).toContain('meeting_url');
  });
});
