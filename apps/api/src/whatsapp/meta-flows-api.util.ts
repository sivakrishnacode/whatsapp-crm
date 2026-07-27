/**
 * Meta WhatsApp **Flows API** helpers (native, in-app flows).
 *
 * This is a DIFFERENT product from the app's internal `flows` engine
 * (`src/flows`, `Flow`/`FlowNode`/`FlowRun`), which is a backend
 * conversational chatbot that only sends ordinary WhatsApp messages.
 * The Flows API here manages *native* flows — the rich, form-like
 * mini-apps (appointment booking, surveys, lead-gen…) that Meta renders
 * inside WhatsApp. Flows are defined by a "Flow JSON" uploaded to Meta
 * and are created/managed under a WABA.
 *
 * Kept in its own file (rather than `meta-api.util.ts`) so the Flows
 * management surface stays cohesive. Every function takes a single
 * named-options object — matches the rest of the WhatsApp module.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
 */

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetaFlowCategory =
  | 'SIGN_UP'
  | 'SIGN_IN'
  | 'APPOINTMENT_BOOKING'
  | 'LEAD_GENERATION'
  | 'CONTACT_US'
  | 'CUSTOMER_SUPPORT'
  | 'SURVEY'
  | 'OTHER';

/** `DRAFT` | `PUBLISHED` | `DEPRECATED` | `BLOCKED` | `THROTTLED`. */
export type MetaFlowStatus = string;

export interface MetaFlowValidationError {
  error: string;
  error_type: string;
  message: string;
  line_start?: number;
  line_end?: number;
  column_start?: number;
  column_end?: number;
  pointers?: Array<{
    line_start?: number;
    line_end?: number;
    column_start?: number;
    column_end?: number;
    path?: string;
  }>;
}

export interface MetaFlowSummary {
  id: string;
  name: string;
  status: MetaFlowStatus;
  categories: string[];
  validation_errors: MetaFlowValidationError[];
}

export interface MetaFlowPreview {
  preview_url: string;
  expires_at: string;
}

export interface MetaFlowDetails extends MetaFlowSummary {
  json_version?: string;
  data_api_version?: string;
  endpoint_uri?: string;
  preview?: MetaFlowPreview;
}

export interface MetaFlowAsset {
  name: string;
  asset_type: string;
  download_url: string;
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Bubble Meta's error `message` (falling back to a generic one). Mirrors
 *  the `throwMetaError` used across `meta-api.util.ts`. */
async function throwFlowMetaError(
  response: Response,
  fallback: string,
): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as MetaErrorResponse;
    if (data.error?.message) message = data.error.message;
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message);
}

function authHeader(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export interface ListFlowsArgs {
  wabaId: string;
  accessToken: string;
}

/** GET /{WABA-ID}/flows — every flow under the business account. */
export async function listFlows(
  args: ListFlowsArgs,
): Promise<MetaFlowSummary[]> {
  const { wabaId, accessToken } = args;
  const url = `${META_API_BASE}/${wabaId}/flows?fields=id,name,status,categories,validation_errors`;
  const response = await fetch(url, { headers: authHeader(accessToken) });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as { data?: MetaFlowSummary[] };
  return data.data ?? [];
}

const DEFAULT_DETAIL_FIELDS =
  'id,name,status,categories,validation_errors,json_version,data_api_version,endpoint_uri,preview';

export interface GetFlowDetailsArgs {
  flowId: string;
  accessToken: string;
  fields?: string;
}

/** GET /{FLOW-ID} — full details for a single flow. */
export async function getFlowDetails(
  args: GetFlowDetailsArgs,
): Promise<MetaFlowDetails> {
  const { flowId, accessToken, fields = DEFAULT_DETAIL_FIELDS } = args;
  const url = `${META_API_BASE}/${flowId}?fields=${encodeURIComponent(fields)}`;
  const response = await fetch(url, { headers: authHeader(accessToken) });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  return (await response.json()) as MetaFlowDetails;
}

export interface GetFlowPreviewArgs {
  flowId: string;
  accessToken: string;
  /** Pass `true` to invalidate the old link and mint a fresh one. */
  invalidate?: boolean;
}

/** GET /{FLOW-ID}?fields=preview.invalidate(<bool>) — a shareable, login-free
 *  preview link. Works for DRAFT flows, so users can test before publishing. */
export async function getFlowPreview(
  args: GetFlowPreviewArgs,
): Promise<MetaFlowPreview | null> {
  const { flowId, accessToken, invalidate = false } = args;
  const url = `${META_API_BASE}/${flowId}?fields=preview.invalidate(${invalidate})`;
  const response = await fetch(url, { headers: authHeader(accessToken) });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as { preview?: MetaFlowPreview };
  return data.preview ?? null;
}

export interface GetFlowAssetsArgs {
  flowId: string;
  accessToken: string;
}

/** GET /{FLOW-ID}/assets — attached assets (the `flow.json` download url). */
export async function getFlowAssets(
  args: GetFlowAssetsArgs,
): Promise<MetaFlowAsset[]> {
  const { flowId, accessToken } = args;
  const url = `${META_API_BASE}/${flowId}/assets`;
  const response = await fetch(url, { headers: authHeader(accessToken) });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as { data?: MetaFlowAsset[] };
  return data.data ?? [];
}

/** Convenience: resolve the current Flow JSON text for a flow by following
 *  its `FLOW_JSON` asset's (signed, no-auth) CDN download url. Returns null
 *  when the flow has no JSON yet. */
export async function downloadFlowJson(
  args: GetFlowAssetsArgs,
): Promise<string | null> {
  const assets = await getFlowAssets(args);
  const jsonAsset = assets.find((a) => a.asset_type === 'FLOW_JSON');
  if (!jsonAsset?.download_url) return null;
  const response = await fetch(jsonAsset.download_url);
  if (!response.ok) return null;
  return await response.text();
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export interface CreateFlowArgs {
  wabaId: string;
  accessToken: string;
  name: string;
  categories: string[];
  /** Flow JSON as a string (Meta expects an escaped JSON string, not an object). */
  flowJson?: string;
  cloneFlowId?: string;
  endpointUri?: string;
  publish?: boolean;
}

export interface CreateFlowResult {
  id: string;
  success?: boolean;
  validation_errors?: MetaFlowValidationError[];
}

/** POST /{WABA-ID}/flows — create a flow (optionally with JSON / clone / publish). */
export async function createFlow(
  args: CreateFlowArgs,
): Promise<CreateFlowResult> {
  const {
    wabaId,
    accessToken,
    name,
    categories,
    flowJson,
    cloneFlowId,
    endpointUri,
    publish,
  } = args;
  const body: Record<string, unknown> = { name, categories };
  if (flowJson) body.flow_json = flowJson;
  if (cloneFlowId) body.clone_flow_id = cloneFlowId;
  if (endpointUri) body.endpoint_uri = endpointUri;
  if (publish !== undefined) body.publish = publish;

  const response = await fetch(`${META_API_BASE}/${wabaId}/flows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(accessToken) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as {
    id?: string;
    success?: boolean;
    validation_errors?: MetaFlowValidationError[];
  };
  if (!data.id) {
    throw new Error('Meta created the flow but returned no id.');
  }
  return {
    id: String(data.id),
    success: data.success,
    validation_errors: data.validation_errors ?? [],
  };
}

export interface UpdateFlowMetadataArgs {
  flowId: string;
  accessToken: string;
  name?: string;
  categories?: string[];
  endpointUri?: string;
}

/** POST /{FLOW-ID} — rename / recategorise a flow (metadata only). */
export async function updateFlowMetadata(
  args: UpdateFlowMetadataArgs,
): Promise<{ success: boolean }> {
  const { flowId, accessToken, name, categories, endpointUri } = args;
  const body: Record<string, unknown> = {};
  if (name !== undefined) body.name = name;
  if (categories !== undefined) body.categories = categories;
  if (endpointUri !== undefined) body.endpoint_uri = endpointUri;

  const response = await fetch(`${META_API_BASE}/${flowId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(accessToken) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
  };
  return { success: data.success !== false };
}

export interface UpdateFlowJsonArgs {
  flowId: string;
  accessToken: string;
  /** The Flow JSON content as a string. */
  flowJson: string;
}

export interface UpdateFlowJsonResult {
  success: boolean;
  validation_errors: MetaFlowValidationError[];
}

/** POST /{FLOW-ID}/assets — replace the flow's `flow.json` (multipart form).
 *  Meta returns `validation_errors` (may come back with a 200) — surfaced so
 *  the editor can highlight problems before publishing. */
export async function updateFlowJson(
  args: UpdateFlowJsonArgs,
): Promise<UpdateFlowJsonResult> {
  const { flowId, accessToken, flowJson } = args;
  const form = new FormData();
  form.append(
    'file',
    new Blob([flowJson], { type: 'application/json' }),
    'flow.json',
  );
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');

  // No explicit Content-Type — fetch sets the multipart boundary itself.
  const response = await fetch(`${META_API_BASE}/${flowId}/assets`, {
    method: 'POST',
    headers: authHeader(accessToken),
    body: form,
  });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as {
    success?: boolean;
    validation_errors?: MetaFlowValidationError[];
  };
  return {
    success: data.success !== false,
    validation_errors: data.validation_errors ?? [],
  };
}

export interface FlowIdArgs {
  flowId: string;
  accessToken: string;
}

/** POST /{FLOW-ID}/publish — publish a validated flow (irreversible metadata-wise). */
export async function publishFlow(
  args: FlowIdArgs,
): Promise<{ success: boolean }> {
  const { flowId, accessToken } = args;
  const response = await fetch(`${META_API_BASE}/${flowId}/publish`, {
    method: 'POST',
    headers: authHeader(accessToken),
  });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
  };
  return { success: data.success !== false };
}

/** POST /{FLOW-ID}/deprecate — retire a published flow (can't be deleted). */
export async function deprecateFlow(
  args: FlowIdArgs,
): Promise<{ success: boolean }> {
  const { flowId, accessToken } = args;
  const response = await fetch(`${META_API_BASE}/${flowId}/deprecate`, {
    method: 'POST',
    headers: authHeader(accessToken),
  });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
  };
  return { success: data.success !== false };
}

/** DELETE /{FLOW-ID} — only allowed while the flow is in DRAFT. */
export async function deleteFlow(
  args: FlowIdArgs,
): Promise<{ success: boolean }> {
  const { flowId, accessToken } = args;
  const response = await fetch(`${META_API_BASE}/${flowId}`, {
    method: 'DELETE',
    headers: authHeader(accessToken),
  });
  if (!response.ok) {
    await throwFlowMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
  };
  return { success: data.success !== false };
}
