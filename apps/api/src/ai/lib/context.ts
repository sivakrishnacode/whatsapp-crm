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

/**
 * The task, stated as a user turn, when the transcript has no customer
 * message left to answer. Phrased as an instruction to write the next
 * message rather than a fake customer line, so the model does not treat
 * it as something the customer said and reply *to* it.
 */
const DRAFT_NUDGE =
  '(The customer has not written since your last message. Write the next message to send them, continuing naturally from where the conversation left off. Do not repeat what has already been sent.)';

/**
 * Make a transcript safe to generate a *draft* from.
 *
 * The draft button can be pressed at any point in a conversation,
 * including when the last thing in the thread is a message the business
 * itself sent. That leaves the transcript ending on an `assistant` turn,
 * and asking a model to continue its own turn with nothing new to answer
 * is not a well-formed request. Gemini in particular returns a candidate
 * with no usable content — empty text with `finishReason: STOP`, or
 * `MALFORMED_RESPONSE`, or occasionally a fragment of nonsense — which
 * reaches the user as "the AI said nothing" with no clue why.
 *
 * So draft mode ends the transcript on a user turn that states the task.
 *
 * ⚠️ Append this for GENERATION ONLY, after `AgentRuntimeService.assemble()`
 * has run. Knowledge retrieval searches on `latestUserMessage()`, which
 * takes the last `user` turn — hand it a nudged transcript and the nudge
 * becomes the search query instead of what the customer actually asked.
 *
 * The auto-reply bot never needs this: it runs from the inbound webhook,
 * so its transcript always ends on a customer turn.
 */
export function withDraftNudge(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  // Only an assistant turn leaves the model with nothing to answer. A
  // trailing `tool` turn is the opposite case — the model asked for that
  // result and owes an answer using it, so nudging there would talk over
  // its own tool call.
  if (!last || last.role !== 'assistant') return messages;
  return [...messages, { role: 'user', content: DRAFT_NUDGE }];
}
