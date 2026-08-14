/**
 * The connector contract.
 *
 * ONE DESCRIPTION OF A FIELD, READ BY BOTH SIDES
 *   A `FieldSpec` is rendered by the automation editor AND validated by
 *   the executor. That is deliberate: the alternative is a form in the
 *   web app and a validator in the API drifting apart, which is the
 *   failure `contact_matches_segment_rule()` vs `lib/segments/rules.ts`
 *   already warns about — a field added to one and not the other saves
 *   fine, renders fine, and does nothing.
 *
 *   The web app FETCHES this catalogue (`GET /connections/catalog`)
 *   rather than duplicating it, so there is exactly one authority.
 *
 * WHY ACTIONS ARE DATA AND NOT STEP TYPES
 *   See docs/app-connections.md, decision D1. `AutomationStepType` is
 *   consumed by an executor switch, a validator, a DTO, a web registry
 *   and a field renderer; twelve Google actions as twelve union members
 *   is twelve edits in five files per app. One `app_action` type plus
 *   this registry keeps the union at its current size, and the picker
 *   still shows every action as a first-class entry.
 */

/** What kind of input a field takes — drives the editor's renderer. */
export type FieldKind =
  | 'text'
  | 'long_text'
  | 'number'
  | 'boolean'
  | 'select'
  /**
   * A dropdown whose options are fetched live from the provider
   * (calendars, sheet tabs). `resource` names the loader on the
   * connector; `dependsOn` lists the fields whose values it needs — a
   * tab list is meaningless without a spreadsheet id.
   */
  | 'resource_select'
  /** Free key/value pairs — a spreadsheet row, a set of headers. */
  | 'key_values'
  /** Comma/newline separated email addresses. */
  | 'email_list';

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  /** One line under the input. Say what breaks if they get it wrong. */
  help?: string;
  placeholder?: string;
  required?: boolean;
  /**
   * Whether `{{ contact.name }}` style tokens are interpolated at run
   * time. False for ids and enums, where a token is almost always a
   * mistake that resolves to "" and fails confusingly.
   */
  tokens?: boolean;
  /** `select` only. */
  options?: { value: string; label: string }[];
  /** `resource_select` only. */
  resource?: string;
  dependsOn?: string[];
  default?: unknown;
}

/** What the provider call produced, published to `context.steps[<key>]`. */
export interface ActionResult {
  /** Merged into the step output. Keys should match `outputs` below. */
  output: Record<string, unknown>;
  /** One line for the automation log. No tokens, no PII beyond a name. */
  detail?: string;
}

export interface ActionContext {
  /** Already interpolated and validated against `inputs`. */
  input: Record<string, unknown>;
  /** A live access token. Refreshed by ConnectionTokenService if needed. */
  accessToken: string;
  /** For log lines only — never for authorisation, which already happened. */
  accountId: string;
}

export interface ResourceContext {
  accessToken: string;
  /** Values of the fields named in `dependsOn`, as far as they are filled. */
  input: Record<string, unknown>;
}

export interface ResourceOption {
  value: string;
  label: string;
}

export interface ConnectorAction {
  /** Stable id stored in step config. Renaming one breaks live automations. */
  id: string;
  label: string;
  /** One line, shown in the step picker. */
  description: string;
  /**
   * Scopes this action alone needs. Checked against the connection's
   * granted scopes BEFORE the call, so a gap becomes a re-consent prompt
   * in the editor rather than a 403 from Google mid-run.
   */
  scopes: string[];
  inputs: FieldSpec[];
  /** Token paths the editor offers after this step — `steps.x.<output>`. */
  outputs: string[];
  /**
   * ⚠️ Set on anything with a side effect the recipient can see. The
   * editor's Test tab refuses to run these without a second confirmation:
   * Google has no dry-run, so "test" on send_email sends a real email.
   */
  irreversible?: boolean;
  execute(ctx: ActionContext): Promise<ActionResult>;
}

export interface Connector {
  /** Which OAuth provider owns the token. Several apps share one. */
  provider: string;
  /** Stable app id stored in step config, e.g. 'google_sheets'. */
  app: string;
  name: string;
  blurb: string;
  /** Two-letter monogram + hue for the picker tile (no external logos). */
  monogram: string;
  hue: string;
  actions: ConnectorAction[];
  resources?: Record<
    string,
    (ctx: ResourceContext) => Promise<ResourceOption[]>
  >;
}

/** The redacted shape the browser is allowed to see. Never has a token. */
export interface ConnectionSummary {
  id: string;
  provider: string;
  displayName: string | null;
  scopes: string[];
  status: 'active' | 'needs_reauth' | 'revoked';
  lastError: string | null;
  createdAt: string;
}

/** Catalogue entry as served to the editor — actions without `execute`. */
export type CatalogAction = Omit<ConnectorAction, 'execute'>;

export interface CatalogApp {
  provider: string;
  app: string;
  name: string;
  blurb: string;
  monogram: string;
  hue: string;
  actions: CatalogAction[];
}
