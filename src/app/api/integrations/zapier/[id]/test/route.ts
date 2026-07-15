// ============================================================
// POST /api/integrations/zapier/{id}/test — fire a one-off signed
// test payload at a connected endpoint, so the user can confirm their
// Zap's trigger step picks it up before turning the Zap on.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { sendTestWebhookPing } from '@/lib/webhooks/deliver';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ctx = await requireRole('admin');

    const result = await sendTestWebhookPing(ctx.supabase, ctx.accountId, id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Test delivery failed' }, { status: 502 });
    }

    return NextResponse.json({ success: true, status: result.status });
  } catch (err) {
    return toErrorResponse(err);
  }
}
