import { PrismaService } from '../../prisma/prisma.service';
import type { ChatMessage } from './types';
import { aiContextMessageLimit } from './defaults';

export async function buildConversationContext(
  prisma: PrismaService,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const data = await prisma.messages.findMany({
    where: {
      conversation_id: conversationId,
      content_type: 'text',
    },
    select: {
      sender_type: true,
      content_text: true,
    },
    orderBy: {
      created_at: 'desc',
    },
    take: limit,
  });

  const rows = [...data].reverse();
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }));
}
