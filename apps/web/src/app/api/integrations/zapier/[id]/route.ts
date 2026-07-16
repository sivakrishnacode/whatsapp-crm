// ============================================================
// PATCH  /api/integrations/zapier/{id} — toggle active / update the
//        subscribed events for one Zapier connection.
// DELETE /api/integrations/zapier/{id} — disconnect it.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { normalizeEvents } from '@/lib/webhooks/events';
import { WEBHOOK_PUBLIC_COLUMNS, serializeWebhookEndpoint } from '@/lib/webhooks/endpoints';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ctx = await requireRole('admin');

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const { is_active, events: rawEvents } = body as Record<string, unknown>;

    const update: Record<string, unknown> = {};
    if (typeof is_active === 'boolean') update.is_active = is_active;
    if (rawEvents !== undefined) {
      const events = normalizeEvents(rawEvents);
      if (!events) {
        return NextResponse.json(
          { error: 'Pick at least one event to trigger this Zap on' },
          { status: 400 }
        );
      }
      update.events = events;
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }
    // A re-enable after auto-disable should also reset the failure
    // streak — otherwise it can immediately re-trip the same threshold.
    if (update.is_active === true) update.failure_count = 0;

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .update(update)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error('[integrations/zapier] update error:', error);
      return NextResponse.json({ error: 'Failed to update connection' }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    return NextResponse.json({ endpoint: serializeWebhookEndpoint(data as Record<string, unknown>) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ctx = await requireRole('admin');

    const { error, count } = await ctx.supabase
      .from('webhook_endpoints')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('account_id', ctx.accountId);

    if (error) {
      console.error('[integrations/zapier] delete error:', error);
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
    }
    if (!count) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
