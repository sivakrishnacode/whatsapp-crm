import { generateReply } from './generate';
import type { AiProvider } from './types';

/**
 * Prove a key works by making the smallest possible real call.
 *
 * Takes only the three fields a call needs, not a whole `AiConfig`: this
 * runs before anything is saved, so there is no profile, no skills and no
 * knowledge to speak of — and a validator that demanded them would force
 * every caller to invent them.
 */
export async function validateAiCredentials(config: {
  provider: AiProvider;
  model: string;
  apiKey: string;
}): Promise<void> {
  await generateReply({
    config,
    systemPrompt:
      'You are a connectivity check. Reply with the single word: OK.',
    messages: [{ role: 'user', content: 'ping' }],
  });
}
