/**
 * Client-side view of the connector catalogue.
 *
 * ⚠️ THESE ARE TYPES AND HELPERS ONLY — NO CATALOGUE DATA LIVES HERE.
 *   The apps, their actions and every field spec are FETCHED from
 *   `GET /api/google-script/catalog`, because the API is the authority:
 *   it validates against the same `FieldSpec` the editor renders from,
 *   and the executor runs the same action list. A second copy in the web
 *   bundle would be a field that renders but does not validate, or
 *   validates but does not render.
 *
 *   Mirrors apps/api/src/google-script/google-script.types.ts.
 */

// ---------------------------------------------------------------------------
// Field specs — shared between old app_action and new google_action
// ---------------------------------------------------------------------------

export type FieldKind =
  | 'text'
  | 'long_text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'resource_select'
  | 'key_values'
  | 'email_list'
  | 'value_list';

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

// ---------------------------------------------------------------------------
// Google Script bridge catalogue (the new system)
// ---------------------------------------------------------------------------

/** One action from the bridge's served catalogue. */
export interface GoogleScriptAction {
  id: string;
  service: string;
  label: string;
  description: string;
  inputs: FieldSpec[];
  outputs: string[];
  /** Sends/creates something real. The Test tab confirms before running. */
  irreversible?: boolean;
}

/** Raw summary from GET /api/google-script. Mirrors
 *  GoogleScriptConnectionSummary on the API. */
export interface GoogleScriptSummary {
  connected: boolean;
  execUrlHint: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string | null;
}

export type GoogleScriptConnectionStatus =
  'not_configured' | 'provisioned' | 'connected' | 'error';

/**
 * Connection status returned by GET /api/google-script, derived from the
 * raw summary by `googleConnectionFromSummary()`.
 */
export interface GoogleScriptConnection {
  status: GoogleScriptConnectionStatus;
  /** The deployment id's trailing characters — enough to tell two apart. */
  displayName: string | null;
  connectedAt: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  /**
   * When that failure happened. Shown next to the message, because a
   * stale error at the top of a setup wizard otherwise reads as something
   * that just went wrong and sends people hunting for a fixed problem.
   */
  lastErrorAt: string | null;
}

/**
 * Map the API's summary onto the richer editorial shape the canvas and
 * the Integrations card consume. The API is the authority on what exists;
 * this only adds derived presentation state.
 */
export function googleConnectionFromSummary(
  summary: GoogleScriptSummary | null | undefined
): GoogleScriptConnection | null {
  if (!summary) return null;
  const status: GoogleScriptConnectionStatus = summary.lastError
    ? 'error'
    : summary.connected
      ? 'connected'
      : summary.createdAt
        ? 'provisioned'
        : 'not_configured';
  return {
    status,
    displayName: summary.execUrlHint,
    connectedAt: summary.createdAt,
    lastTestedAt: summary.lastOkAt,
    lastError: summary.lastError,
    lastErrorAt: summary.lastErrorAt,
  };
}

/** Config shape of a `google_action` step. No connection_id, no app. */
export interface GoogleActionConfig {
  action?: string;
  input?: Record<string, unknown>;
}

/** Service labels from the catalogue (e.g. { sheets: 'Google Sheets' }). */
export type GoogleServiceLabels = Record<string, string>;

// ---------------------------------------------------------------------------
// Old OAuth types (kept for backward compat with saved app_action steps)
// ---------------------------------------------------------------------------

export interface CatalogAction {
  id: string;
  label: string;
  description: string;
  scopes: string[];
  inputs: FieldSpec[];
  outputs: string[];
  irreversible?: boolean;
}

export interface CatalogApp {
  provider: string;
  app: string;
  name: string;
  blurb: string;
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

/** Config shape of an `app_action` step. DEPRECATED. */
export interface AppActionConfig {
  connection_id?: string;
  app?: string;
  action?: string;
  input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers — Google Script bridge
// ---------------------------------------------------------------------------

export function findGoogleAction(
  actions: GoogleScriptAction[],
  actionId: string | undefined
): GoogleScriptAction | undefined {
  return actionId ? actions.find((a) => a.id === actionId) : undefined;
}

/** Group actions by their service field. */
export function groupByService(
  actions: GoogleScriptAction[],
  labels: GoogleServiceLabels
): { service: string; label: string; actions: GoogleScriptAction[] }[] {
  const groups = new Map<string, GoogleScriptAction[]>();
  for (const action of actions) {
    const list = groups.get(action.service) ?? [];
    list.push(action);
    groups.set(action.service, list);
  }
  return Array.from(groups.entries()).map(([service, acts]) => ({
    service,
    label: labels[service] ?? service,
    actions: acts,
  }));
}

// ---------------------------------------------------------------------------
// Helpers — old OAuth (kept for app_action backward compat)
// ---------------------------------------------------------------------------

export function findApp(
  apps: CatalogApp[],
  appId: string | undefined
): CatalogApp | undefined {
  return appId ? apps.find((a) => a.app === appId) : undefined;
}

export function findAction(
  app: CatalogApp | undefined,
  actionId: string | undefined
): CatalogAction | undefined {
  return actionId ? app?.actions.find((a) => a.id === actionId) : undefined;
}

export function connectionsFor(
  connections: AppConnection[],
  app: CatalogApp | undefined
): AppConnection[] {
  if (!app) return [];
  return connections.filter((c) => c.provider === app.provider);
}

export function appScopes(app: CatalogApp): string[] {
  return Array.from(new Set(app.actions.flatMap((a) => a.scopes)));
}

export function connectionsGranting(
  connections: AppConnection[],
  app: CatalogApp | undefined
): AppConnection[] {
  if (!app) return [];
  const needed = appScopes(app);
  return connectionsFor(connections, app).filter((c) =>
    needed.every((scope) => c.scopes.includes(scope))
  );
}

export function missingScopes(
  connection: AppConnection | undefined,
  action: CatalogAction | undefined
): string[] {
  if (!connection || !action) return [];
  return action.scopes.filter((s) => !connection.scopes.includes(s));
}

export function connectUrl(app: CatalogApp, returnTo: string): string {
  const params = new URLSearchParams({ app: app.app, returnTo });
  return `/api/connections/${app.provider}/oauth/start?${params.toString()}`;
}
