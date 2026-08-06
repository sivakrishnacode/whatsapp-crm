import {
  AiError,
  type AiConfig,
  type ChatMessage,
  type GenerateResult,
  type ToolCall,
  type ToolDefinition,
  type ToolTraceEntry,
} from './types';
import {
  HANDOFF_SENTINEL,
  aiMaxToolRounds,
  aiRequestTimeoutMs,
} from './defaults';
import { generateOpenAi } from './providers/openai';
import { generateAnthropic } from './providers/anthropic';
import { generateGemini } from './providers/gemini';
import type { ProviderArgs, ProviderTurn } from './providers/shared';

/** Runs one tool call and returns what the model should see next. */
export type ToolExecutor = (
  call: ToolCall,
) => Promise<{ ok: boolean; detail: string }>;

export interface GenerateArgs {
  config: Pick<AiConfig, 'provider' | 'model' | 'apiKey'>;
  systemPrompt: string;
  messages: ChatMessage[];
  /** Tools the model may call this run. Empty = single-shot completion. */
  tools?: ToolDefinition[];
  executeTool?: ToolExecutor;
}

async function callProvider(
  provider: string,
  args: ProviderArgs,
): Promise<ProviderTurn> {
  switch (provider) {
    case 'openai':
      return generateOpenAi(args);
    case 'anthropic':
      return generateAnthropic(args);
    case 'gemini':
      return generateGemini(args);
    default:
      throw new AiError(`Unsupported AI provider: ${provider}`, {
        code: 'unsupported_provider',
        status: 400,
      });
  }
}

/**
 * Generate the next reply, running any tools the model asks for.
 *
 * The loop is bounded twice over — `aiMaxToolRounds()` round-trips and a
 * hard cap of 8 calls per round — because every round is a paid provider
 * call on the account's own key, and a model that has decided to call
 * the same tool forever should cost pennies, not a bill.
 *
 * On the last permitted round the tools are withheld, so the model is
 * forced to answer from what the earlier calls returned instead of
 * asking for one more thing nobody will run.
 */
export async function generateReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools, executeTool } = args;
  const timeoutMs = aiRequestTimeoutMs();
  const useTools = Boolean(tools && tools.length > 0 && executeTool);
  const maxRounds = useTools ? aiMaxToolRounds() : 0;

  const transcript: ChatMessage[] = [...messages];
  const trace: ToolTraceEntry[] = [];

  for (let round = 0; round <= maxRounds; round++) {
    const isFinalRound = round === maxRounds;
    const turn = await callProvider(config.provider, {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      messages: transcript,
      timeoutMs,
      tools: useTools && !isFinalRound ? tools : undefined,
    });

    if (turn.toolCalls.length === 0 || !useTools || isFinalRound) {
      return { ...parseGeneration(turn.text), toolTrace: trace };
    }

    const calls = turn.toolCalls.slice(0, 8);
    transcript.push({
      role: 'assistant',
      content: turn.text,
      toolCalls: calls,
    });

    for (const call of calls) {
      const startedAt = Date.now();
      let result: { ok: boolean; detail: string };
      try {
        result = await executeTool!(call);
      } catch (err) {
        // A thrown executor is a bug on our side, not the model's — but
        // the model still needs *something* back, or the transcript is
        // malformed for the next round.
        result = {
          ok: false,
          detail: err instanceof Error ? err.message : 'Tool failed.',
        };
      }
      trace.push({
        name: call.name,
        arguments: call.arguments,
        ok: result.ok,
        detail: result.detail.slice(0, 2000),
        durationMs: Date.now() - startedAt,
      });
      transcript.push({
        role: 'tool',
        content: result.detail,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }

  // Unreachable: the loop always returns on `isFinalRound`.
  throw new AiError('The assistant could not finish its reply.', {
    code: 'tool_loop_exhausted',
  });
}

export function parseGeneration(raw: string): {
  text: string;
  handoff: boolean;
} {
  const handoff = raw.includes(HANDOFF_SENTINEL);
  const text = raw.split(HANDOFF_SENTINEL).join('').trim();
  return { text, handoff };
}
