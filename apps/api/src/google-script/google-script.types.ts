/**
 * Contracts for the Google Apps Script bridge (migration 092).
 *
 * ONE INTEGRATION, FOUR PRODUCTS. Gmail, Calendar, Meet and Sheets are
 * reached through a SINGLE script the customer deploys in their own
 * Google account: one `/exec` URL, one secret, one row. The old OAuth
 * connector modelled four apps because incremental consent made
 * "connected" a per-scope question; here there is nothing to consent to
 * incrementally, so four cards would be four ways of displaying one
 * credential. The UI shows one Google integration.
 *
 * `FieldKind` / `FieldSpec` keep the shape the previous catalogue used so
 * the automation editor renders and validates from the same server-served
 * spec — a field cannot render without validating.
 *
 * ⚠️ `resource_select` is deliberately absent. Listing a customer's
 * spreadsheet tabs needed a live access token, and we no longer hold one:
 * the script does, and asking it to enumerate resources at edit time
 * would mean a round trip per keystroke through somebody else's quota.
 * Tab names are typed.
 */

export type FieldKind =
  | 'text'
  | 'long_text'
  | 'number'
  | 'boolean'
  | 'select'
  /** Comma/newline separated email addresses. */
  | 'email_list'
  /** Comma-separated cell values for a spreadsheet row. */
  | 'value_list';

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
   * time. False for enums, where a token is almost always a mistake that
   * resolves to "" and fails confusingly.
   */
  tokens?: boolean;
  /** `select` only. */
  options?: { value: string; label: string }[];
  default?: unknown;
}

/**
 * Which Google product an action belongs to. Presentation only — every
 * action travels the same URL with the same secret. Used to group the
 * step picker so "Send email" sits under Gmail rather than in a flat list
 * of seven.
 */
export type GoogleService = 'gmail' | 'calendar' | 'sheets';

export interface GoogleScriptAction {
  /**
   * Stable id, stored in step config AND sent to the script as `action`.
   * Renaming one breaks live automations *and* every already-deployed
   * script, which we cannot update — see the guide's "no update channel".
   */
  id: string;
  service: GoogleService;
  label: string;
  description: string;
  inputs: FieldSpec[];
  /** Keys published to `context.steps[<key>]`. */
  outputs: string[];
  /**
   * True when running it twice does something a customer would notice
   * twice — a second email, a second calendar invite. Surfaced in the
   * editor; the engine does not retry these.
   */
  irreversible?: boolean;
}

/**
 * What the browser may know about the workspace's bridge.
 *
 * ⚠️ NO SECRET, EVER, AND NOT EVEN THE FULL URL BY DEFAULT. The URL is
 * half a credential: with the secret it sends mail as the customer, and
 * a screenshot of an Integrations page should not carry either half.
 * `execUrlHint` is the deployment id's last few characters, which is
 * enough for a human to tell two deployments apart and useless to
 * anyone else.
 */
export interface GoogleScriptConnectionSummary {
  connected: boolean;
  execUrlHint: string | null;
  /** Last time a real call succeeded. Null = configured but never used. */
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string | null;
}

/** Result of one bridge call, published to the automation context. */
export interface GoogleScriptCallResult {
  output: Record<string, unknown>;
  /** One line for the automation log. No secrets, no PII beyond a name. */
  detail?: string;
}
