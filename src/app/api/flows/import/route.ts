import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * POST /api/flows/import
 *
 * Accepts a JSON body that matches the shape produced by
 * GET /api/flows/[id]/export and creates a new **draft** flow
 * (with fresh UUIDs) owned by the calling user's account.
 *
 * Idempotency: each call creates a new flow — no duplicate detection.
 * The caller must set `Content-Type: application/json`.
 *
 * Errors:
 *   400 — missing/invalid fields or unrecognised schema_version
 *   401 — not authenticated
 *   403 — caller is not at least `agent`
 *   500 — database failure
 */

/** The shape of a single exported node (stripped of DB ids). */
interface ExportedNode {
  node_key: string
  node_type: string
  config: Record<string, unknown>
  position_x?: number
  position_y?: number
}

/** The shape produced by GET /api/flows/[id]/export. */
interface FlowExportPayload {
  schema_version: number
  exported_at?: string
  flow: {
    name: string
    description?: string | null
    status?: string
    trigger_type: 'keyword' | 'first_inbound_message' | 'manual'
    trigger_config?: Record<string, unknown>
    entry_node_id?: string | null
    fallback_policy?: Record<string, unknown>
  }
  nodes: ExportedNode[]
}

const SUPPORTED_SCHEMA_VERSIONS = [1]

export async function POST(request: Request) {
  // Writes require at least `agent`.
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Resolve the caller's account_id.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  // Parse the request body.
  const body = (await request.json().catch(() => null)) as FlowExportPayload | null
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Validate schema_version.
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(body.schema_version)) {
    return NextResponse.json(
      {
        error: `Unsupported schema_version "${body.schema_version}". ` +
          `Supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`,
      },
      { status: 400 },
    )
  }

  // Validate the `flow` block.
  const { flow: flowDef, nodes: nodeDefs = [] } = body
  if (!flowDef) {
    return NextResponse.json(
      { error: 'Missing "flow" field in export payload.' },
      { status: 400 },
    )
  }
  if (!flowDef.name?.trim()) {
    return NextResponse.json(
      { error: 'flow.name is required and cannot be empty.' },
      { status: 400 },
    )
  }
  const validTriggers = ['keyword', 'first_inbound_message', 'manual'] as const
  if (!validTriggers.includes(flowDef.trigger_type)) {
    return NextResponse.json(
      { error: `Invalid trigger_type "${flowDef.trigger_type}".` },
      { status: 400 },
    )
  }

  // Validate nodes array shape.
  if (!Array.isArray(nodeDefs)) {
    return NextResponse.json({ error: '"nodes" must be an array.' }, { status: 400 })
  }
  for (const n of nodeDefs) {
    if (typeof n.node_key !== 'string' || !n.node_key.trim()) {
      return NextResponse.json(
        { error: 'Each node must have a non-empty "node_key".' },
        { status: 400 },
      )
    }
    if (typeof n.node_type !== 'string' || !n.node_type.trim()) {
      return NextResponse.json(
        { error: 'Each node must have a non-empty "node_type".' },
        { status: 400 },
      )
    }
  }

  const admin = supabaseAdmin()

  // Insert the flow as a fresh draft — always `status: 'draft'` regardless
  // of what the export file carries. The user can activate it after review.
  const { data: flow, error: flowErr } = await admin
    .from('flows')
    .insert({
      user_id: user.id,
      account_id: accountId,
      name: flowDef.name.trim(),
      description: flowDef.description ?? null,
      status: 'draft',
      trigger_type: flowDef.trigger_type,
      trigger_config: flowDef.trigger_config ?? {},
      entry_node_id: flowDef.entry_node_id ?? null,
      fallback_policy: flowDef.fallback_policy ?? undefined,
    })
    .select()
    .single()

  if (flowErr || !flow) {
    return NextResponse.json(
      { error: flowErr?.message ?? 'Flow insert failed' },
      { status: 500 },
    )
  }

  // Insert nodes if any.
  if (nodeDefs.length > 0) {
    const { error: nodesErr } = await admin.from('flow_nodes').insert(
      nodeDefs.map((n) => ({
        flow_id: flow.id,
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config ?? {},
        position_x: n.position_x ?? 0,
        position_y: n.position_y ?? 0,
      })),
    )
    if (nodesErr) {
      // Roll back — a half-inserted flow is worse than no flow.
      await admin.from('flows').delete().eq('id', flow.id)
      return NextResponse.json({ error: nodesErr.message }, { status: 500 })
    }
  }

  return NextResponse.json({ flow }, { status: 201 })
}
