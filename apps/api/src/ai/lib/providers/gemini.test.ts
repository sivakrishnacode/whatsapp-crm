import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateGemini } from './gemini';
import { AiError } from '../types';

/**
 * Gemini's request shape differs from OpenAI's and Anthropic's in three
 * ways that each produce a confusing runtime failure rather than a type
 * error, so they are pinned here:
 *
 *   * the system prompt is `system_instruction`, not a message
 *   * the assistant role is `model`
 *   * the key goes in the `x-goog-api-key` HEADER, never `?key=` (a query
 *     string ends up in logs and proxy traces, and this is the customer's
 *     own billable credential)
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function captureFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseArgs = {
  apiKey: 'test-key',
  model: 'gemini-3.5-flash',
  systemPrompt: 'You are a test agent.',
  timeoutMs: 5000,
};

describe('generateGemini', () => {
  it('sends the key as a header and the system prompt as system_instruction', async () => {
    const fetchMock = captureFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }),
    );

    const turn = await generateGemini({
      ...baseArgs,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(turn.text).toBe('Hello');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/models/gemini-3.5-flash:generateContent');
    expect(String(url)).not.toContain('key=');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');

    const body = requestBody(fetchMock);
    expect(body.system_instruction.parts[0].text).toBe('You are a test agent.');
  });

  it('accepts a fully qualified model id without doubling the prefix', async () => {
    const fetchMock = captureFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );

    await generateGemini({
      ...baseArgs,
      model: 'models/gemini-3.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/v1beta/models/gemini-3.5-flash:generateContent',
    );
  });

  it('maps assistant turns to role "model" and drops a leading one', async () => {
    const fetchMock = captureFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );

    await generateGemini({
      ...baseArgs,
      messages: [
        { role: 'assistant', content: 'unprompted opener' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'still there?' },
      ],
    });

    const body = requestBody(fetchMock);
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual([
      'user',
      'model',
      'user',
    ]);
  });

  it('returns function calls and sends results back as functionResponse', async () => {
    const fetchMock = captureFetch(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'lookup_orders', args: { order_reference: 'A-1' } } }],
            },
          },
        ],
      }),
    );

    const turn = await generateGemini({
      ...baseArgs,
      messages: [{ role: 'user', content: 'where is order A-1' }],
      tools: [
        {
          name: 'lookup_orders',
          description: 'Look up orders',
          parameters: {
            type: 'object',
            properties: { order_reference: { type: 'string' } },
          },
        },
      ],
    });

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].name).toBe('lookup_orders');
    expect(turn.toolCalls[0].arguments).toEqual({ order_reference: 'A-1' });

    const body = requestBody(fetchMock);
    expect(body.tools[0].functionDeclarations[0].name).toBe('lookup_orders');

    // Round two: the tool result must come back as a functionResponse part
    // on a `user` turn, or Gemini rejects the transcript.
    const second = captureFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'It shipped.' }] } }] }),
    );
    await generateGemini({
      ...baseArgs,
      messages: [
        { role: 'user', content: 'where is order A-1' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'lookup_orders', arguments: {} }],
        },
        { role: 'tool', content: 'status: shipped', toolCallId: 'c1', toolName: 'lookup_orders' },
      ],
    });

    const followUp = requestBody(second);
    const last = followUp.contents[followUp.contents.length - 1];
    expect(last.role).toBe('user');
    expect(last.parts[0].functionResponse.name).toBe('lookup_orders');
    expect(last.parts[0].functionResponse.response.result).toBe('status: shipped');
  });

  it('round-trips the thought signature with the call it belongs to', async () => {
    // Verified against the live API: a Gemini 3 model returns a
    // `thoughtSignature` alongside its functionCall, and the follow-up
    // turn has to carry it back or the model loses the reasoning behind
    // the call it just made.
    const first = captureFetch(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'lookup_orders', args: { order_reference: 'A-1' } },
                  thoughtSignature: 'sig-abc',
                },
              ],
            },
          },
        ],
      }),
    );

    const turn = await generateGemini({
      ...baseArgs,
      messages: [{ role: 'user', content: 'where is A-1' }],
      tools: [
        {
          name: 'lookup_orders',
          description: 'Look up orders',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });
    expect(turn.toolCalls[0].signature).toBe('sig-abc');
    expect(first).toHaveBeenCalledTimes(1);

    const second = captureFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'It shipped.' }] } }] }),
    );
    await generateGemini({
      ...baseArgs,
      messages: [
        { role: 'user', content: 'where is A-1' },
        { role: 'assistant', content: '', toolCalls: turn.toolCalls },
        { role: 'tool', content: 'shipped', toolCallId: turn.toolCalls[0].id, toolName: 'lookup_orders' },
      ],
    });

    const contents = requestBody(second).contents;
    const modelTurn = contents.find((c: { role: string }) => c.role === 'model');
    expect(modelTurn.parts[0].thoughtSignature).toBe('sig-abc');
  });

  it('leaves headroom above the reply budget for thinking tokens', async () => {
    // Thinking tokens are charged against maxOutputTokens. Sized for the
    // reply alone, a Gemini 3 model returns zero content parts with
    // finishReason MAX_TOKENS, which reads as "the AI said nothing".
    const fetchMock = captureFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );

    await generateGemini({
      ...baseArgs,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(
      requestBody(fetchMock).generationConfig.maxOutputTokens,
    ).toBeGreaterThan(1024);
  });

  it('strips JSON Schema keywords Gemini rejects', async () => {
    const fetchMock = captureFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );

    await generateGemini({
      ...baseArgs,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'check_stock',
          description: 'Check stock',
          parameters: {
            type: 'object',
            properties: { sku: { type: 'string' } },
            // @ts-expect-error deliberately passing a keyword Gemini rejects
            additionalProperties: false,
          },
        },
      ],
    });

    const schema = requestBody(fetchMock).tools[0].functionDeclarations[0].parameters;
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.properties.sku.type).toBe('string');
  });

  it('explains a safety block instead of reporting an empty reply', async () => {
    captureFetch(
      jsonResponse({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
        promptFeedback: { blockReason: 'SAFETY' },
      }),
    );

    await expect(
      generateGemini({ ...baseArgs, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'content_blocked' });
  });

  it('surfaces an invalid key as invalid_key', async () => {
    captureFetch(jsonResponse({ error: { message: 'API key not valid' } }, 403));

    const err = await generateGemini({
      ...baseArgs,
      messages: [{ role: 'user', content: 'hi' }],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe('invalid_key');
  });
});
