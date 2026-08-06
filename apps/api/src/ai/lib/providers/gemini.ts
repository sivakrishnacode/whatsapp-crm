import { AiError, type ChatMessage, type ToolDefinition } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
  type ProviderTurn,
} from './shared';

/**
 * ============================================================
 * Google Gemini (Generative Language API).
 *
 * Three ways this API differs from the other two, all of which have
 * bitten someone before:
 *
 *   1. The assistant role is called `model`, not `assistant`, and the
 *      system prompt is its own top-level `system_instruction` object
 *      rather than a message.
 *   2. The key goes in an `x-goog-api-key` HEADER. It is also accepted
 *      as a `?key=` query parameter — do not use that: query strings end
 *      up in access logs and proxy traces, and this is a customer's own
 *      billable credential.
 *   3. A function call comes back as a `functionCall` PART, and its
 *      result must be sent back as a `functionResponse` part in a turn
 *      with role `user`. There is no call id to correlate with, so the
 *      pairing is positional — which is why the tool loop must keep the
 *      results in the same order the calls arrived.
 *
 * Version is pinned to `v1beta`: it is the surface that carries
 * `system_instruction` and function calling for the current models.
 * ============================================================
 */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Extra output budget for the model's own reasoning — see the note in
 *  `generateGemini` on why the reply budget alone is not enough. */
const THINKING_HEADROOM = 3072;

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  /** Opaque reasoning state on thinking models — see MAX_TOKENS note below. */
  thoughtSignature?: string;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Gemini's schema dialect is OpenAPI-ish and rejects a few JSON Schema
 * keywords outright (`additionalProperties`, `$schema`, `examples`). Our
 * tool definitions are simple enough that stripping them is sufficient,
 * and stripping is safer than a translation layer that silently drops
 * meaning.
 */
function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'additionalProperties' || key === '$schema' || key === 'examples') {
      continue;
    }
    out[key] = toGeminiSchema(val);
  }
  return out;
}

function toGeminiTools(tools: ToolDefinition[]): unknown {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toGeminiSchema(t.parameters),
      })),
    },
  ];
}

function toGeminiContents(messages: ChatMessage[]): unknown[] {
  const merged = mergeConsecutive(messages);
  const out: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];

  for (const m of merged) {
    if (m.role === 'tool') {
      const part = {
        functionResponse: {
          name: m.toolName ?? 'tool',
          // The API requires an object here; our tools return a string,
          // so it is wrapped rather than parsed — a tool that returns
          // prose must not become invalid JSON at the boundary.
          response: { result: m.content },
        },
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user') {
        last.parts.push(part);
      } else {
        out.push({ role: 'user', parts: [part] });
      }
      continue;
    }

    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const parts: unknown[] = [];
    if (m.content.trim()) parts.push({ text: m.content });
    for (const call of m.toolCalls ?? []) {
      parts.push({
        functionCall: { name: call.name, args: call.arguments },
        // Echoed verbatim: a thinking model that does not get its own
        // signature back loses the reasoning behind the call it just
        // made, and on Gemini 3 the turn can be rejected outright.
        ...(call.signature ? { thoughtSignature: call.signature } : {}),
      });
    }
    if (parts.length === 0) continue;
    out.push({ role, parts });
  }

  while (out.length > 0 && out[0].role === 'model') {
    out.shift();
  }
  if (out.length === 0) {
    return [
      {
        role: 'user',
        parts: [{ text: '(The customer has not sent a message yet.)' }],
      },
    ];
  }
  return out;
}

export async function generateGemini(args: ProviderArgs): Promise<ProviderTurn> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args;

  // Model ids are stored bare ("gemini-3.5-flash") but the path wants
  // "models/<id>"; accept either so a user who pastes the fully
  // qualified name from Google's docs is not punished for it.
  const modelPath = model.startsWith('models/') ? model : `models/${model}`;

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: toGeminiContents(messages),
    // THINKING TOKENS COUNT AGAINST THIS BUDGET. On a Gemini 3 model a
    // one-line answer routinely spends 200+ tokens thinking first, and a
    // budget sized for the reply alone comes back as a candidate with
    // zero content parts and finishReason MAX_TOKENS — which reads as
    // "the AI said nothing" with no clue why. The headroom is not
    // permission to write more: reply length is governed by the prompt.
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS + THINKING_HEADROOM },
  };
  if (tools && tools.length > 0) {
    body.tools = toGeminiTools(tools);
  }

  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE}/${modelPath}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res);
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null;
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();

  const toolCalls = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({
      id: `${p.functionCall!.name}_${i}`,
      name: p.functionCall!.name!,
      arguments:
        p.functionCall!.args && typeof p.functionCall!.args === 'object'
          ? p.functionCall!.args
          : {},
      ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}),
    }));

  if (!text && toolCalls.length === 0) {
    // A safety block is a *successful* HTTP response with no candidate
    // content, so it has to be diagnosed here or it reads as a
    // mysterious empty reply.
    const blocked =
      data?.promptFeedback?.blockReason ??
      (candidate?.finishReason && candidate.finishReason !== 'STOP'
        ? candidate.finishReason
        : null);
    if (blocked) {
      throw new AiError(
        `Gemini stopped without answering (${blocked}). Rephrase the business profile or knowledge that triggered it.`,
        { code: 'content_blocked' },
      );
    }
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    });
  }

  return { text, toolCalls };
}
