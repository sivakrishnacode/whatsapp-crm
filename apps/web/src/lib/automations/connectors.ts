/**
 * Client-side view of the connector catalogue.
 *
 * ⚠️ THESE ARE TYPES AND HELPERS ONLY — NO CATALOGUE DATA LIVES HERE.
 *   The apps, their actions and every field spec are FETCHED from
 *   `GET /api/connections/catalog`, because the API is the authority:
 *   it validates against the same `FieldSpec` the editor renders from,
 *   and the executor runs the same action list. A second copy in the web
 *   bundle would be a field that renders but does not validate, or
 *   validates but does not render — the exact drift documented between
 *   `contact_matches_segment_rule()` and `lib/segments/rules.ts`.
 *
 *   Mirrors apps/api/src/connections/connections.types.ts. There is no
 *   shared types package yet, so change both together.
 */

export type FieldKind =
  | 'text'
  | 'long_text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'resource_select'
  | 'key_values'
  | 'email_list';

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  placeholder?: string;
  required?: boolean;
  /** Whether `{{ }}` tokens are interpolated — drives the token picker. */
  tokens?: boolean;
  options?: { value: string; label: string }[];
  resource?: string;
  dependsOn?: string[];
  default?: unknown;
}

export interface CatalogAction {
  id: string;
  label: string;
  description: string;
  scopes: string[];
  inputs: FieldSpec[];
  outputs: string[];
  /** Sends/creates something real. The Test tab confirms before running. */
  irreversible?: boolean;
}

export interface CatalogApp {
  provider: string;
  app: string;
  name: string;
  blurb: string;
  /** Self-hosted product icon under /public/icons. Monogram is the fallback. */
  icon?: string;
  monogram: string;
  hue: string;
  actions: CatalogAction[];
}

export interface AppConnection {
  id: string;
  provider: string;
  displayName: string | null;
  scopes: string[];
  status: 'active' | 'needs_reauth' | 'revoked';
  lastError: string | null;
  createdAt: string;
}

/** Config shape of an `app_action` step. Mirrors AppActionStepConfig. */
export interface AppActionConfig {
  connection_id?: string;
  app?: string;
  action?: string;
  input?: Record<string, unknown>;
}

export function findApp(
  apps: CatalogApp[],
  appId: string | undefined,
): CatalogApp | undefined {
  return appId ? apps.find((a) => a.app === appId) : undefined;
}

export function findAction(
  app: CatalogApp | undefined,
  actionId: string | undefined,
): CatalogAction | undefined {
  return actionId ? app?.actions.find((a) => a.id === actionId) : undefined;
}

/**
 * Connections usable for an app: right provider, and still working.
 *
 * A `needs_reauth` connection is deliberately still OFFERED rather than
 * filtered out — it is almost always the one the author meant, and a
 * dropdown that silently omits it looks like the account was never
 * connected. It is shown with its state instead, so the fix is obvious.
 */
export function connectionsFor(
  connections: AppConnection[],
  app: CatalogApp | undefined,
): AppConnection[] {
  if (!app) return [];
  return connections.filter((c) => c.provider === app.provider);
}

/**
 * Does this connection cover everything the action needs?
 *
 * Mirrors the server-side check in ConnectorExecutionService. It is a
 * warning in the editor and a refusal on the server — the editor's job
 * is to say so before activation, not to be the gate.
 */
export function missingScopes(
  connection: AppConnection | undefined,
  action: CatalogAction | undefined,
): string[] {
  if (!connection || !action) return [];
  return action.scopes.filter((s) => !connection.scopes.includes(s));
}

/** Where to send the browser to connect (or widen) an app. */
export function connectUrl(app: CatalogApp, returnTo: string): string {
  const params = new URLSearchParams({ app: app.app, returnTo });
  return `/api/connections/${app.provider}/oauth/start?${params.toString()}`;
}
