import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { findGoogleScriptAction } from '../google-script.catalog';
import type { GoogleScriptCallResult } from '../google-script.types';
import { GoogleScriptConnectionService } from './google-script-connection.service';

/** Apps Script can be slow; a step holds a queue worker while it waits. */
const TIMEOUT_MS = 30_000;
/** Response bytes we will read. A Google error page is far bigger than any result. */
const MAX_BYTES = 128 * 1024;

export class GoogleScriptError extends Error {
  constructor(
    message: string,
    readonly output?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GoogleScriptError';
  }
}

/**
 * Performs one bridge action against the workspace's own Apps Script.
 *
 * ⚠️ THE ACCOUNT IS THE AUTHORITY; THE STEP CONFIG IS NOT.
 *   A step names an ACTION and its FIELDS — never a URL and never a
 *   secret. The deployment is resolved from the running automation's
 *   `accountId`, which is the same rule the old `connection_id` needed and
 *   for a bigger prize: a config-supplied URL would let anyone who can
 *   edit an automation point our server, carrying another workspace's
 *   secret, at a host they control.
 *
 * ⚠️ THE 302 IS THE NORMAL CASE, AND WE FOLLOW IT AS A **GET**.
 *   Apps Script answers a POST to /exec with a 302 to
 *   script.googleusercontent.com, which serves the response body. Every
 *   browser and every sane HTTP client downgrades a 302 to GET; replaying
 *   the POST (what `redirect: 'manual'` plus a naive retry would do)
 *   re-sends the body to a URL that only serves GET and returns a Drive
 *   error page — which reads exactly like a broken script.
 *
 *   Following it matters for more than tidiness: without the body there
 *   are no OUTPUTS, so `create_event` could not hand `meeting_url` to the
 *   next step and `sheet_find` could not publish what it found. That was
 *   the one real regression against the OAuth connector, and this is where
 *   it is bought back.
 *
 *   The redirect target is pinned to one host. `redirect: 'manual'` stays,
 *   because an unvalidated hop is how a public URL walks into a private
 *   address — the same reason the automation http_request step refuses to
 *   follow redirects at all.
 */
@Injectable()
export class GoogleScriptExecutorService {
  private readonly logger = new Logger(GoogleScriptExecutorService.name);

  constructor(private readonly connections: GoogleScriptConnectionService) {}

  /**
   * Run `actionId` with already-interpolated `input`.
   *
   * Throws `GoogleScriptError` for anything the customer needs to fix; the
   * message is written to be readable in an automation log by somebody who
   * has never seen Apps Script.
   */
  async run(
    accountId: string,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<GoogleScriptCallResult> {
    const action = findGoogleScriptAction(actionId);
    if (!action) {
      throw new GoogleScriptError(
        `Unknown Google action "${actionId}". If this automation used to work, ` +
          'the workspace may have been re-set-up with a different script.',
      );
    }

    const creds = await this.connections.resolveCredentials(accountId);
    if (!creds) {
      throw new GoogleScriptError(
        'Google is not connected for this workspace. ' +
          'Set it up in Settings → Integrations → Google.',
      );
    }

    const missing = action.inputs
      .filter((f) => f.required)
      .filter((f) => {
        const v = input[f.key];
        return v === undefined || v === null || v === '';
      })
      .map((f) => f.label);
    if (missing.length) {
      throw new GoogleScriptError(`${action.label} needs: ${missing.join(', ')}.`);
    }

    const body = JSON.stringify({ ...input, secret: creds.secret, action: actionId });

    try {
      const parsed = await this.post(creds.execUrl, body);
      if (parsed.ok === false) {
        throw new GoogleScriptError(this.explain(String(parsed.error ?? 'unknown error')));
      }
      await this.connections.recordSuccess(accountId);
      // `ok` and `action` are protocol, not result — strip them so
      // `context.steps[<key>]` holds only what the action produced.
      const { ok: _ok, action: _action, ...output } = parsed;
      return { output, detail: this.detailFor(actionId, output) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.connections.recordFailure(accountId, message);
      if (err instanceof GoogleScriptError) throw err;
      throw new GoogleScriptError(message);
    }
  }

  /**
   * POST, then follow exactly one Apps Script redirect as a GET.
   *
   * Deliberately not `safeFetch`: that helper replays the original method
   * on every hop (correct for the AI agent's arbitrary user URLs, wrong
   * here), and this call needs a tighter control anyway — one known host
   * rather than "anything publicly routable".
   */
  private async post(execUrl: string, body: string): Promise<Record<string, unknown>> {
    const first = await this.fetchOnce(execUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    let response = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('location');
      if (!location) {
        throw new GoogleScriptError(
          'Google redirected without saying where. Redeploy the script and try again.',
        );
      }
      const target = new URL(location, execUrl);
      if (
        target.hostname !== GoogleScriptConnectionService.RESPONSE_HOST &&
        target.hostname !== 'script.google.com'
      ) {
        // Not a scenario Apps Script produces; if it happens, something is
        // intercepting, and following it would carry nothing secret but
        // would still be a request we did not intend.
        throw new GoogleScriptError(
          `Google redirected somewhere unexpected (${target.hostname}). Nothing was sent there.`,
        );
      }
      // GET, and no body: this hop only fetches the reply.
      response = await this.fetchOnce(target.toString(), { method: 'GET' });
    }

    const text = await this.readCapped(response);

    if (response.status === 401 || response.status === 403 || /<html/i.test(text.slice(0, 200))) {
      throw new GoogleScriptError(
        'The script returned a web page instead of a result. This is almost always ' +
          '"Who has access" being set to something other than Anyone — redeploy it ' +
          'with access: Anyone.',
      );
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new GoogleScriptError(
        `The script replied with something that is not JSON (HTTP ${response.status}). ` +
          'Check its Executions log in Apps Script.',
      );
    }
  }

  private async fetchOnce(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new GoogleScriptError(
          `The script did not respond within ${TIMEOUT_MS / 1000}s. Apps Script is ` +
            'sometimes slow to wake; if it keeps happening, check its Executions log.',
        );
      }
      throw new GoogleScriptError(
        `Could not reach the script: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async readCapped(res: Response): Promise<string> {
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf).subarray(0, MAX_BYTES);
    return new TextDecoder().decode(bytes);
  }

  /**
   * Turn the script's own error into something actionable.
   *
   * The bridge is deliberately vague about auth failures (a caller without
   * the secret should learn nothing), which is unhelpful to the one person
   * who is allowed to know — so translate it here, where we know the
   * caller is the workspace itself.
   */
  private explain(error: string): string {
    if (error === 'unauthorized') {
      return (
        'The script rejected our secret. This happens when the script was re-pasted ' +
        'or redeployed with a different secret — regenerate it in Settings → ' +
        'Integrations → Google and paste the new script in.'
      );
    }
    if (/is not defined/.test(error)) {
      return `${error}. In the Apps Script editor, add Services → Calendar API.`;
    }
    if (/Meet API/.test(error)) {
      return `${error}. Use "Add a Google Meet link" on Create calendar event instead.`;
    }
    return error;
  }

  private detailFor(actionId: string, output: Record<string, unknown>): string {
    switch (actionId) {
      case 'send_email':
        return `Emailed ${String(output.to ?? '')}`;
      case 'create_event':
        return output.meeting_url ? `Event created with a Meet link` : 'Event created';
      case 'check_availability':
        return `${Array.isArray(output.busy) ? output.busy.length : 0} busy block(s)`;
      case 'sheet_append':
        return `Row ${String(output.row ?? '')} added`;
      case 'sheet_find':
        return output.found ? `Found row ${String(output.row ?? '')}` : 'No matching row';
      case 'sheet_update':
        return output.found ? `Row ${String(output.row ?? '')} updated` : 'No matching row';
      default:
        return 'Done';
    }
  }
}
