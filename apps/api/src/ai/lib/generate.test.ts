import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateReply, parseGeneration } from './generate';
import { HANDOFF_SENTINEL } from './defaults';
import type { ToolDefinition } from './types';

/**
 * The tool loop spends the account's own provider credit on every round,
 * so what matters is that it TERMINATES and that it never leaves the
 * transcript malformed:
 *
 *   * a model that keeps calling tools is cut off at the round limit
 *   * on the final round the tools are withheld, so the model is forced
 *     to answer from what it already has instead of asking for one more
 *     thing nobody will run
 *   * a throwing executor still produces a tool result, because a missing
 *     one breaks the next request
 */

function geminiText(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function geminiCall(name: string, args: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const config = { provider: 'gemini' as const, model: 'gemini-3.5-flash', apiKey: 'k' };

const tools: ToolDefinition[] = [
  {
    name: 'lookup_orders',
    description: 'Look up orders',
    parameters: { type: 'object', properties: {} },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_MAX_TOOL_ROUNDS;
});

describe('parseGeneration', () => {
  it('strips the handoff sentinel and reports the handoff', () => {
    expect(parseGeneration(`${HANDOFF_SENTINEL}`)).toEqual({ text: '', handoff: true });
    expect(parseGeneration('Sure, one moment.')).toEqual({
      text: 'Sure, one moment.',
      handoff: false,
    });
  });
});

describe('generateReply', () => {
  it('makes exactly one call when no tools are offered', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiText('Hello'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateReply({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.text).toBe('Hello');
    expect(result.toolTrace).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs a requested tool and feeds the result back', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiCall('lookup_orders', { order_reference: 'A-1' }))
      .mockResolvedValueOnce(geminiText('Your order shipped yesterday.'));
    vi.stubGlobal('fetch', fetchMock);

    const executeTool = vi
      .fn()
      .mockResolvedValue({ ok: true, detail: 'status: shipped' });

    const result = await generateReply({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'where is A-1' }],
      tools,
      executeTool,
    });

    expect(result.text).toBe('Your order shipped yesterday.');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0]).toMatchObject({
      name: 'lookup_orders',
      arguments: { order_reference: 'A-1' },
    });

    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0]).toMatchObject({ name: 'lookup_orders', ok: true });

    // The follow-up request carries the tool result back to the provider.
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const last = secondBody.contents[secondBody.contents.length - 1];
    expect(last.parts[0].functionResponse.response.result).toBe('status: shipped');
  });

  it('stops at the round limit and withholds tools on the last call', async () => {
    process.env.AI_MAX_TOOL_ROUNDS = '2';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiCall('lookup_orders'))
      .mockResolvedValueOnce(geminiCall('lookup_orders'))
      .mockResolvedValueOnce(geminiText('I could not confirm that.'));
    vi.stubGlobal('fetch', fetchMock);

    const executeTool = vi.fn().mockResolvedValue({ ok: true, detail: 'no orders' });

    const result = await generateReply({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'where is my order' }],
      tools,
      executeTool,
    });

    expect(result.text).toBe('I could not confirm that.');
    // rounds 0 and 1 called tools; round 2 is the forced answer.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(2);

    const lastBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(lastBody.tools).toBeUndefined();
  });

  it('turns a throwing executor into a tool result rather than failing the reply', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiCall('lookup_orders'))
      .mockResolvedValueOnce(geminiText('I could not check that just now.'));
    vi.stubGlobal('fetch', fetchMock);

    const executeTool = vi.fn().mockRejectedValue(new Error('db down'));

    const result = await generateReply({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'where is my order' }],
      tools,
      executeTool,
    });

    expect(result.text).toBe('I could not check that just now.');
    expect(result.toolTrace[0]).toMatchObject({ ok: false, detail: 'db down' });
  });

  it('rejects an unknown provider before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateReply({
        config: { provider: 'mistral' as never, model: 'm', apiKey: 'k' },
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'unsupported_provider' });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
