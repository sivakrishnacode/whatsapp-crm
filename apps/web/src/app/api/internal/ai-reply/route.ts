import { NextResponse } from 'next/server';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';

export async function POST(request: Request) {
  const secret = request.headers.get('x-internal-secret');
  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { accountId, conversationId, contactId, configOwnerUserId } = await request.json();

  try {
    await dispatchInboundToAiReply({
      accountId,
      conversationId,
      contactId,
      configOwnerUserId,
    });
  } catch (err) {
    console.error('[ai-reply-bridge] failed:', err);
  }

  return NextResponse.json({ ok: true });
}
