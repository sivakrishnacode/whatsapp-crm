import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import {
  platformApiKey,
  platformEmbeddingsModel,
  platformModel,
} from '../credits/credits.constants';
import { resolveSkills } from './skills';
import { AiError } from './types';
import type {
  AgentSkills,
  AgentTone,
  AiConfig,
  AiCreditMode,
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
  credit_mode: true,
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

function asCreditMode(value: unknown): AiCreditMode {
  return value === 'byok' ? 'byok' : 'platform';
}

/** Current wallet balance, without creating the wallet. */
async function readBalance(
  prisma: PrismaService,
  accountId: string,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ balance: number }[]>`
    SELECT balance FROM ai_credit_wallets WHERE account_id = ${accountId}::uuid
  `;
  return rows[0]?.balance ?? 0;
}

/**
 * ============================================================
 * Which key does this run spend?
 *
 * The workspace's stored `credit_mode` is the decision, and it is
 * honoured whenever it can be. Fallback happens ONLY when the chosen
 * source cannot serve the call at all — never as a preference:
 *
 *   platform chosen, no server key   → their own key, if they have one
 *   platform chosen, wallet empty    → their own key, if they have one
 *   byok chosen, no key stored       → platform, if we have a key
 *
 * The asymmetry is deliberate. Falling back *to* someone's own key when
 * ours cannot serve them keeps their agent answering customers, and
 * costs them exactly what they already agreed to pay Google. Falling
 * back the other way — quietly spending our credits because their key
 * had a bad minute — would bill them for something they did not choose.
 *
 * Nothing here reads a key from the browser or from a job payload: the
 * platform key comes from the environment and theirs from an encrypted
 * column, both at call time.
 * ============================================================
 */
function resolveSource(args: {
  chosen: AiCreditMode;
  ownKey: string | null;
  balance: number;
}): { source: AiCreditMode; usable: boolean } {
  const { chosen, ownKey, balance } = args;
  const platformKey = platformApiKey();

  if (chosen === 'byok') {
    if (ownKey) return { source: 'byok', usable: true };
    if (platformKey) return { source: 'platform', usable: balance >= 1 };
    return { source: 'byok', usable: false };
  }

  if (platformKey && balance >= 1) return { source: 'platform', usable: true };
  if (ownKey) return { source: 'byok', usable: true };
  // Out of credits with no key of their own. Reported as `platform` so
  // the caller raises "top up" rather than "configure a provider".
  return { source: 'platform', usable: false };
}

/**
 * A workspace with no `ai_configs` row at all, running on the platform
 * key and its welcome credits.
 *
 * Before credits, no row meant no AI — the row existed only because
 * someone had pasted a key. Now the useful default is the other way
 * round: a brand-new workspace should be able to press "Draft with AI"
 * in the inbox and have it work, which is the entire argument for
 * giving away the first 250 credits. Every behaviour field takes the
 * same default the agent studio shows for an unconfigured agent.
 */
function platformOnlyConfig(balance: number): AiConfig {
  return {
    provider: 'gemini',
    model: platformModel(),
    apiKey: platformApiKey()!,
    source: 'platform',
    creditMode: 'platform',
    creditBalance: balance,
    systemPrompt: null,
    isActive: true,
    // Answering customers unprompted is never a default. Drafting on
    // request is; the human presses the button and reads the result.
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: platformApiKey(),
    embeddingsProvider: 'gemini',
    embeddingsModel: platformEmbeddingsModel(),
    profile: {
      agentName: null,
      greetingMessage: null,
      businessWebsite: null,
      businessDescription: null,
      groundRules: null,
      storeCurrency: null,
    },
    voice: {
      tone: 'friendly',
      responseLength: 'medium',
      toneInstructions: null,
    },
    escalation: {
      fallbackMessage: null,
      handoffEnabled: false,
      handoffTriggerPhrases: [],
      handoffMessage: null,
    },
    skills: resolveSkills(null),
    testMode: false,
    testNumbers: [],
  };
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

  const creditMode = asCreditMode(config?.credit_mode);
  const balance = await readBalance(prisma, accountId);

  // No row at all is no longer "AI is unavailable": a workspace that has
  // never opened the agent screen still has welcome credits and can be
  // drafted for. Only the absence of ANY usable key means unavailable.
  if (!config) {
    if (!platformApiKey()) return null;
    return platformOnlyConfig(balance);
  }

  if (requireActive && !config.is_active) return null;

  let ownKey: string | null = null;
  if (config.api_key) {
    try {
      ownKey = decrypt(config.api_key);
    } catch {
      // A key that will not decrypt is not a key. Surfacing it as
      // "unconfigured" would be a lie; letting it fall through to the
      // platform key silently moves them onto our bill. Neither — the
      // caller gets a diagnosis it can show.
      throw new AiError(
        'Your stored provider key could not be decrypted — re-enter it in AI Agents → Provider.',
        { code: 'key_decrypt_failed', status: 400 },
      );
    }
  }

  const { source, usable } = resolveSource({
    chosen: creditMode,
    ownKey,
    balance,
  });

  if (source === 'byok' && !ownKey && !usable) return null;

  const platformKey = platformApiKey();
  if (source === 'platform' && !platformKey) return null;

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

  // On the platform key, embeddings ride the same credential — which is
  // how a platform workspace gets semantic search without going and
  // finding an OpenAI key of its own. Only when they have no embeddings
  // key at all: an account that configured one has vectors stored under
  // THAT model, and swapping the model out from under them would filter
  // their whole corpus out of retrieval (see the note on
  // `embeddings_model`).
  const onPlatform = source === 'platform';
  const lendPlatformEmbeddings = onPlatform && !embeddingsApiKey;
  if (lendPlatformEmbeddings) {
    embeddingsApiKey = platformKey;
  }

  return {
    provider: onPlatform ? 'gemini' : (config.provider as AiProvider),
    model: onPlatform ? platformModel() : config.model,
    apiKey: onPlatform ? platformKey! : ownKey!,
    source,
    creditMode,
    creditBalance: balance,
    systemPrompt: config.system_prompt,
    isActive: config.is_active,
    autoReplyEnabled: config.auto_reply_enabled,
    autoReplyMaxPerConversation: config.auto_reply_max_per_conversation,
    embeddingsApiKey,
    embeddingsProvider: lendPlatformEmbeddings
      ? 'gemini'
      : asEmbeddingsProvider(config.embeddings_provider),
    embeddingsModel: lendPlatformEmbeddings
      ? platformEmbeddingsModel()
      : config.embeddings_model,
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
  /** Whose key `key` is. `platform` means indexing is billable. */
  source: AiCreditMode;
}

/**
 * The key that indexes knowledge.
 *
 * A platform workspace is lent OUR key here, which is what gives it
 * semantic search without anyone going to find an OpenAI account — the
 * same reasoning as `loadAiConfig`, and the reason indexing is metered
 * (cheaply: see `EMBEDDING_TOKENS_PER_CREDIT`).
 *
 * A workspace that chose bring-your-own-key is NOT lent it, even though
 * we could. Their choice was "do not bill me", and quietly embedding
 * their documents on our key would bill them for it.
 */
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
      credit_mode: true,
    },
  });

  const provider =
    asEmbeddingsProvider(config?.embeddings_provider) ?? 'openai';
  const model = config?.embeddings_model ?? null;

  /** Our key, offered only to a workspace that opted into platform AI. */
  const platformFallback = (corrupt: boolean): EmbeddingsKeyResult => {
    const key = platformApiKey();
    if (!key || asCreditMode(config?.credit_mode) !== 'platform') {
      return { key: null, corrupt, provider, model, source: 'byok' };
    }
    return {
      key,
      corrupt,
      provider: 'gemini',
      model: platformEmbeddingsModel(),
      source: 'platform',
    };
  };

  if (!config || !config.embeddings_api_key) {
    return platformFallback(false);
  }

  try {
    return {
      key: decrypt(config.embeddings_api_key),
      corrupt: false,
      provider,
      model,
      source: 'byok',
    };
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    );
    // Undecryptable is the same as absent for indexing purposes, so a
    // platform workspace still gets indexed rather than silently losing
    // semantic search over a key it is not even using.
    return platformFallback(true);
  }
}
