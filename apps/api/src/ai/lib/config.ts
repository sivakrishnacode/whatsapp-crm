import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/security/encryption.util';
import type { AiConfig } from './types';

export async function loadAiConfig(
  prisma: PrismaService,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts;
  const config = await prisma.ai_configs.findUnique({
    where: { account_id: accountId },
    select: {
      provider: true,
      model: true,
      api_key: true,
      system_prompt: true,
      is_active: true,
      auto_reply_enabled: true,
      auto_reply_max_per_conversation: true,
      embeddings_api_key: true,
    },
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
    provider: config.provider as any,
    model: config.model,
    apiKey: decrypt(config.api_key),
    systemPrompt: config.system_prompt,
    isActive: config.is_active,
    autoReplyEnabled: config.auto_reply_enabled,
    autoReplyMaxPerConversation: config.auto_reply_max_per_conversation,
    embeddingsApiKey,
  };
}

export async function loadEmbeddingsKey(
  prisma: PrismaService,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const config = await prisma.ai_configs.findUnique({
    where: { account_id: accountId },
    select: { embeddings_api_key: true },
  });

  if (!config || !config.embeddings_api_key) {
    return { key: null, corrupt: false };
  }

  try {
    return { key: decrypt(config.embeddings_api_key), corrupt: false };
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    );
    return { key: null, corrupt: true };
  }
}
