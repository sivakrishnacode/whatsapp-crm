import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/flows/[id]/export
 *
 * Returns a portable JSON export of the flow and its nodes.
 * - Strips `account_id`, `user_id`, and all internal auto-generated
 *   UUIDs (`id`, `flow_id`) so the file can be imported to any account.
 * - Preserves `node_key` references which are the stable edge identifiers
 *   used inside JSONB configs, so the graph wires up correctly on import.
 * - Response is `application/json` with a `Content-Disposition: attachment`
 *   header so the browser triggers a file download when hit directly.
 */

async function requireOwnership(
  flowId: string,
): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>> }
  | { ok: false; status: number; body: { error: string } }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } }
  }
  const { data: flow } = await supabase
    .from('flows')
    .select('id')
    .eq('id', flowId)
    .maybeSingle()
  if (!flow) {
    return { ok: false, status: 404, body: { error: 'Not found' } }
  }
  return { ok: true, supabase }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireOwnership(id)
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status })
  }
  const { supabase } = guard

  const [{ data: flow }, { data: nodes }] = await Promise.all([
    supabase.from('flows').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
  ])
  if (!flow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Build a portable export payload — strip server-managed / tenant fields.
  const exportPayload = {
    /** Schema version — increment when the shape changes incompatibly. */
    schema_version: 1,
    exported_at: new Date().toISOString(),
    flow: {
      name: flow.name,
      description: flow.description,
      status: 'draft' as const,         // always import as draft
      trigger_type: flow.trigger_type,
      trigger_config: flow.trigger_config,
      entry_node_id: flow.entry_node_id, // node_key-based — safe to carry over
      fallback_policy: flow.fallback_policy,
    },
    nodes: (nodes ?? []).map((n) => ({
      node_key: n.node_key,
      node_type: n.node_type,
      config: n.config,
      position_x: n.position_x,
      position_y: n.position_y,
    })),
  }

  const safeName = flow.name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()
  const filename = `flow_${safeName}_${Date.now()}.json`

  return new NextResponse(JSON.stringify(exportPayload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
