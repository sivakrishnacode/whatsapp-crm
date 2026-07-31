import { getCountries, getCountryCallingCode } from 'libphonenumber-js'

/**
 * Country options for the default-country picker.
 *
 * Derived from libphonenumber's own metadata rather than hand-listed
 * (the way `CURRENCIES` in lib/currency.ts is), because this list has
 * to stay in step with what `toE164` will actually accept — offering
 * a country the parser doesn't know would let a user pick a setting
 * that silently does nothing.
 *
 * Display names come from `Intl.DisplayNames`, so the picker is
 * localized by the browser for free.
 */

export interface CountryOption {
  /** ISO 3166-1 alpha-2, e.g. "IN". Stored verbatim in the DB. */
  code: string
  /** Localized country name, e.g. "India". */
  label: string
  /** E.164 calling code without the `+`, e.g. "91". */
  callingCode: string
}

/**
 * Every country libphonenumber can parse, sorted by localized name.
 *
 * Built once at module load: ~240 entries through `Intl.DisplayNames`
 * is cheap once and needless on every render of a settings panel.
 */
export const COUNTRIES: CountryOption[] = buildCountries()

function buildCountries(): CountryOption[] {
  // `Intl.DisplayNames` is in every browser we support, but a missing
  // implementation must not take the settings page down with it — the
  // ISO code alone is still a usable (if terse) label.
  let displayNames: Intl.DisplayNames | null = null
  try {
    displayNames = new Intl.DisplayNames(undefined, { type: 'region' })
  } catch {
    displayNames = null
  }

  return getCountries()
    .map((code) => ({
      code,
      label: displayNames?.of(code) ?? code,
      callingCode: getCountryCallingCode(code),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Look up one option, or undefined for an unknown/stale code. */
export function findCountry(code: string | null | undefined) {
  if (!code) return undefined
  const upper = code.toUpperCase()
  return COUNTRIES.find((c) => c.code === upper)
}

/**
 * Label a country for compact display, e.g. "India (+91)". Falls back
 * to the raw code so a value the metadata no longer knows still
 * renders.
 */
export function formatCountryLabel(code: string | null | undefined): string {
  const country = findCountry(code)
  return country ? `${country.label} (+${country.callingCode})` : (code ?? '')
}
