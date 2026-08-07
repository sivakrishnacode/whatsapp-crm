import type { VariableMapping } from '../services/dashboard-broadcast.service';

/**
 * Reserved keys inside `broadcasts.template_variables`.
 *
 * That column is a per-variable mapping keyed by placeholder token, so
 * an underscore prefix is what keeps these send-time extras from
 * colliding with a template's own variable named "headerText". Stored
 * there rather than in new columns because they are exactly as
 * per-broadcast as the variable mapping already in that Json.
 *
 * They exist because a template's requirements are not limited to its
 * body: a LOCATION header needs a pin, a media header needs a URL when
 * the template carries no default, and URL/COPY_CODE buttons need their
 * substitution. Meta rejects the entire send when one is missing, so a
 * broadcast that could not carry them simply failed for every
 * recipient.
 *
 * These moved out of dashboard-broadcast.service.ts when delivery
 * became a fan-out queue: the write side (that service) and the read
 * side (the per-recipient processor) now live in different files, and
 * two copies of a magic string that must match is precisely the bug
 * this file prevents.
 */
export const HEADER_MEDIA_KEY = '_headerMediaUrl';
export const HEADER_TEXT_KEY = '_headerText';
export const HEADER_LOCATION_KEY = '_headerLocation';
export const BUTTON_PARAMS_KEY = '_buttonParams';

/** Every reserved key, so variable resolution can skip them. */
export const RESERVED_VARIABLE_KEYS = new Set([
  HEADER_MEDIA_KEY,
  HEADER_TEXT_KEY,
  HEADER_LOCATION_KEY,
  BUTTON_PARAMS_KEY,
]);

export interface HeaderLocation {
  latitude: string;
  longitude: string;
  name?: string;
  address?: string;
}

export interface BroadcastTemplateConfig {
  headerMediaUrl?: string;
  headerText?: string;
  headerLocation?: HeaderLocation;
  /** Keyed by button index, as `sendTemplateMessage` expects. */
  buttonParams: Record<number, string>;
  /** The real placeholder mapping, with reserved keys removed. */
  variables: Record<string, VariableMapping>;
}

/**
 * Split a stored `template_variables` blob into the send-time extras
 * and the placeholder mapping proper.
 *
 * Pure and total: a broadcast row created before any of these keys
 * existed parses to "no extras", and a half-written header location
 * (one coordinate) is dropped rather than passed on — Meta rejects the
 * whole send for a malformed pin, which would turn one bad field into
 * every recipient failing.
 */
export function parseBroadcastTemplateConfig(
  raw: unknown,
): BroadcastTemplateConfig {
  const rawVariables = (raw ?? {}) as Record<string, unknown>;

  const headerMediaUrl =
    typeof rawVariables[HEADER_MEDIA_KEY] === 'string'
      ? rawVariables[HEADER_MEDIA_KEY]
      : undefined;
  const headerText =
    typeof rawVariables[HEADER_TEXT_KEY] === 'string'
      ? rawVariables[HEADER_TEXT_KEY]
      : undefined;

  const rawLocation = rawVariables[HEADER_LOCATION_KEY] as
    Partial<HeaderLocation> | undefined;
  const headerLocation =
    rawLocation?.latitude && rawLocation?.longitude
      ? (rawLocation as HeaderLocation)
      : undefined;

  const storedButtonParams = (rawVariables[BUTTON_PARAMS_KEY] ?? {}) as Record<
    string,
    string
  >;
  const buttonParams = Object.fromEntries(
    Object.entries(storedButtonParams).map(([k, v]) => [Number(k), v]),
  ) as Record<number, string>;

  // The reserved keys share this object with the real variable
  // mapping; passing them through as variables would have the resolver
  // look for a template placeholder called "_headerText".
  const variables = Object.fromEntries(
    Object.entries(rawVariables).filter(
      ([key]) => !RESERVED_VARIABLE_KEYS.has(key),
    ),
  ) as Record<string, VariableMapping>;

  return {
    ...(headerMediaUrl ? { headerMediaUrl } : {}),
    ...(headerText ? { headerText } : {}),
    ...(headerLocation ? { headerLocation } : {}),
    buttonParams,
    variables,
  };
}

/**
 * The `messageParams` object `sendTemplateMessage` takes, built from a
 * parsed config. Empty keys are omitted rather than sent as undefined
 * because the builder branches on presence.
 */
export function toMessageParams(
  config: BroadcastTemplateConfig,
  bodyNamed?: Record<string, string>,
): Record<string, unknown> {
  return {
    ...(config.headerMediaUrl ? { headerMediaUrl: config.headerMediaUrl } : {}),
    ...(config.headerText ? { headerText: config.headerText } : {}),
    ...(config.headerLocation ? { headerLocation: config.headerLocation } : {}),
    ...(Object.keys(config.buttonParams).length > 0
      ? { buttonParams: config.buttonParams }
      : {}),
    ...(bodyNamed ? { bodyNamed } : {}),
  };
}
