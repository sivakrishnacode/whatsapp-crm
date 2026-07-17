import { generateReply } from './generate';
import type { AiConfig } from './types';

export async function validateAiCredentials(config: AiConfig): Promise<void> {
  await generateReply({
    config,
    systemPrompt: 'You are a connectivity check. Reply with the single word: OK.',
    messages: [{ role: 'user', content: 'ping' }],
  });
}
