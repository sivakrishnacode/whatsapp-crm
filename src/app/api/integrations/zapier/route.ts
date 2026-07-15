// ============================================================
// GET  /api/integrations/zapier — list this account's Zapier
//      webhook endpoints (session-authenticated, for the dashboard
//      "App Integrations" card — the public/API-key CRUD at
//      /api/v1/webhooks manages the same `webhook_endpoints` table
//      for external programmatic use).
// POST /api/integrations/zapier — connect a Zapier "Catch Hook" URL,
//      subscribed to the chosen CRM events.
//
// A Zapier connection IS a webhook_endpoints row — there's no
// separate "provider" column. Any row managed here also shows up via
// the public API and vice versa.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  serializeWebhookEndpoint,
  generateWebhookSecret,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints';
import { encrypt } from '@/lib/whatsapp/encryption';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[integrations/zapier] list error:', error);
      return NextResponse.json({ error: 'Failed to list connections' }, { status: 500 });
    }

    return NextResponse.json({
      endpoints: (data ?? []).map((r) => serializeWebhookEndpoint(r as Record<string, unknown>)),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('admin');

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }

    const url = normalizeWebhookUrl((body as Record<string, unknown>).url);
    if (!url) {
      return NextResponse.json(
        { error: "Enter a valid https:// Zapier webhook URL" },
        { status: 400 }
      );
    }

    const events = normalizeEvents((body as Record<string, unknown>).events);
    if (!events) {
      return NextResponse.json(
        { error: 'Pick at least one event to trigger this Zap on' },
        { status: 400 }
      );
    }

    const secret = generateWebhookSecret();

    const { data: created, error } = await ctx.supabase
      .from('webhook_endpoints')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        url,
        secret: encrypt(secret),
        events,
      })
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .single();

    if (error || !created) {
      console.error('[integrations/zapier] create error:', error);
      return NextResponse.json({ error: 'Failed to connect Zapier' }, { status: 500 });
    }

    // Secret shown exactly once, same convention as the public API — an
    // advanced user can wire it into a "Code by Zapier" step to verify
    // the `X-Conceps-Signature` header, but Zapier's Catch Hook trigger
    // works fine without it.
    return NextResponse.json(
      { endpoint: { ...serializeWebhookEndpoint(created as Record<string, unknown>), secret } },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
