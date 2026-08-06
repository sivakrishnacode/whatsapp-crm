import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import { resolveSkills } from './skills';
import type {
  AgentSkills,
  AgentTone,
  AiConfig,
  AiProvider,
  EmbeddingsProvider,
  ResponseLength,
} from './types';

const TONES: AgentTone[] = ['friendly', 'professional', 'concise', 'playful'];
const LENGTHS: ResponseLength[] = ['short', 'medium', 'long'];

/** Every column the runtime needs. Kept in one place so the three
 *  callers (draft, playground, auto-reply bot) cannot drift apart. */
const CONFIG_SELECT = {
  provider: true,
  model: true,
  api_key: true,
  system_prompt: true,
  is_active: true,
  auto_reply_enabled: true,
  auto_reply_max_per_conversation: true,
  embeddings_api_key: true,
  embeddings_provider: true,
  embeddings_model: true,
  agent_name: true,
  greeting_message: true,
  business_website: true,
  business_description: true,
  ground_rules: true,
  store_currency: true,
  tone: true,
  response_length: true,
  tone_instructions: true,
  fallback_message: true,
  handoff_enabled: true,
  handoff_trigger_phrases: true,
  handoff_message: true,
  skills: true,
  test_mode: true,
  test_numbers: true,
} as const;

/** Column values come from a CHECK-constrained column, but a bad row (or
 *  a future value this build doesn't know) must degrade, not throw. */
function asTone(value: unknown): AgentTone {
  return TONES.includes(value as AgentTone) ? (value as AgentTone) : 'friendly';
}

function asLength(value: unknown): ResponseLength {
  return LENGTHS.includes(value as ResponseLength)
    ? (value as ResponseLength)
    : 'medium';
}

function asEmbeddingsProvider(value: unknown): EmbeddingsProvider | null {
  return value === 'gemini' || value === 'openai' ? value : null;
}

function asSkills(value: unknown): AgentSkills {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return resolveSkills(null);
  }
  return resolveSkills(value as AgentSkills);
}

export async function loadAiConfig(
  prisma: PrismaService,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts;
  const config = await prisma.ai_configs.findUnique({
    where: { account_id: accountId },
    select: CONFIG_SELECT,
  });

  if (!config) return null;
  if (requireActive && !config.is_active) return null;
  if (!config.api_key) return null;

  let embeddingsApiKey: string | null = null;
  if (config.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(config.embeddings_api_key);
    } catch {
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      );
      embeddingsApiKey = null;
    }
  }

  return {
    provider: config.provider as AiProvider,
    model: config.model,
    apiKey: decrypt(config.api_key),
    systemPrompt: config.system_prompt,
    isActive: config.is_active,
    autoReplyEnabled: config.auto_reply_enabled,
    autoReplyMaxPerConversation: config.auto_reply_max_per_conversation,
    embeddingsApiKey,
    embeddingsProvider: asEmbeddingsProvider(config.embeddings_provider),
    embeddingsModel: config.embeddings_model,
    profile: {
      agentName: config.agent_name,
      greetingMessage: config.greeting_message,
      businessWebsite: config.business_website,
      businessDescription: config.business_description,
      groundRules: config.ground_rules,
      storeCurrency: config.store_currency,
    },
    voice: {
      tone: asTone(config.tone),
      responseLength: asLength(config.response_length),
      toneInstructions: config.tone_instructions,
    },
    escalation: {
      fallbackMessage: config.fallback_message,
      handoffEnabled: config.handoff_enabled,
      handoffTriggerPhrases: config.handoff_trigger_phrases ?? [],
      handoffMessage: config.handoff_message,
    },
    skills: asSkills(config.skills),
    testMode: config.test_mode,
    testNumbers: config.test_numbers ?? [],
  };
}

export interface EmbeddingsKeyResult {
  key: string | null;
  corrupt: boolean;
  provider: EmbeddingsProvider;
  model: string | null;
}

export async function loadEmbeddingsKey(
  prisma: PrismaService,
  accountId: string,
): Promise<EmbeddingsKeyResult> {
  const config = await prisma.ai_configs.findUnique({
    where: { account_id: accountId },
    select: {
      embeddings_api_key: true,
      embeddings_provider: true,
      embeddings_model: true,
    },
  });

  const provider = asEmbeddingsProvider(config?.embeddings_provider) ?? 'openai';
  const model = config?.embeddings_model ?? null;

  if (!config || !config.embeddings_api_key) {
    return { key: null, corrupt: false, provider, model };
  }

  try {
    return {
      key: decrypt(config.embeddings_api_key),
      corrupt: false,
      provider,
      model,
    };
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    );
    return { key: null, corrupt: true, provider, model };
  }
}
