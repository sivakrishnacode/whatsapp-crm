/**
 * How a hosted form looks.
 *
 * ⚠️ THE DEFAULT SCHEME IS LIGHT, AND DELIBERATELY NOT THE APP'S DEFAULT.
 *   `DEFAULT_MODE` in lib/themes.ts is `dark`, and an anonymous visitor
 *   has no `converse360.mode` in localStorage — so every public form used
 *   to render dark. The owner never saw that (their dashboard is whatever
 *   they picked) and had no control over it. A hosted form is the
 *   business's page, not the visitor's app, so its scheme is the owner's
 *   decision with a light default, and `system` is opt-in rather than
 *   imposed.
 *
 * ⚠️ ACCENT IS VALIDATED, NOT TRUSTED.
 *   It reaches the browser as a CSS custom property, so an unchecked
 *   string is style injection. `safeAccent` is the only way it is ever
 *   read, on both the server and the client.
 */

export const FORM_COLOR_SCHEMES = ['light', 'dark', 'system'] as const;
export type FormColorScheme = (typeof FORM_COLOR_SCHEMES)[number];

export const FORM_HEADER_STYLES = [
  'gradient',
  'solid',
  'bar',
  'none',
] as const;
export type FormHeaderStyle = (typeof FORM_HEADER_STYLES)[number];

export interface FormTheme {
  color_scheme: FormColorScheme;
  /** `#rrggbb`. Drives the header, the buttons and every focus ring. */
  accent: string;
  header_style: FormHeaderStyle;
  /** Rounded corners on inputs and buttons. */
  rounded: 'sharp' | 'soft' | 'pill';
  /** Hides the "Powered by" line under the card. */
  hide_branding: boolean;
}

export const DEFAULT_ACCENT = '#7c3aed';

export const DEFAULT_FORM_THEME: FormTheme = {
  color_scheme: 'light',
  accent: DEFAULT_ACCENT,
  header_style: 'gradient',
  rounded: 'soft',
  hide_branding: false,
};

/** Presets for the colour picker. Names are what a non-designer searches for. */
export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: 'Violet', value: '#7c3aed' },
  { name: 'Indigo', value: '#4f46e5' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Cyan', value: '#0891b2' },
  { name: 'Teal', value: '#0d9488' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Lime', value: '#65a30d' },
  { name: 'Amber', value: '#d97706' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Pink', value: '#db2777' },
  { name: 'Slate', value: '#475569' },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * The only way an accent is ever read.
 *
 * Returns the default for anything that is not exactly `#rrggbb`. The
 * value is interpolated into a `style` attribute as a custom property, so
 * a permissive parse here is a CSS injection on a public page — and a
 * form whose accent silently falls back to violet is a much smaller
 * problem than one that renders somebody else's declarations.
 */
export function safeAccent(value: unknown): string {
  return typeof value === 'string' && HEX_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : DEFAULT_ACCENT;
}

/** Coerce a stored blob into a complete theme. Never throws. */
export function resolveFormTheme(raw: unknown): FormTheme {
  const t = (raw ?? {}) as Partial<FormTheme>;
  return {
    color_scheme: FORM_COLOR_SCHEMES.includes(t.color_scheme as FormColorScheme)
      ? (t.color_scheme as FormColorScheme)
      : DEFAULT_FORM_THEME.color_scheme,
    accent: safeAccent(t.accent),
    header_style: FORM_HEADER_STYLES.includes(t.header_style as FormHeaderStyle)
      ? (t.header_style as FormHeaderStyle)
      : DEFAULT_FORM_THEME.header_style,
    rounded:
      t.rounded === 'sharp' || t.rounded === 'pill'
        ? t.rounded
        : DEFAULT_FORM_THEME.rounded,
    hide_branding: Boolean(t.hide_branding),
  };
}

/**
 * Relative luminance, for deciding whether text on the accent should be
 * black or white.
 *
 * Picking one and hoping is how a yellow button ends up with white text
 * at 1.3:1. sRGB coefficients per WCAG 2.x.
 */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  );
}

/** Black or white, whichever contrasts better against the accent. */
export function accentForeground(accent: string): string {
  return luminance(safeAccent(accent)) > 0.45 ? '#111827' : '#ffffff';
}

/** The radius scale, as a CSS length. */
const RADIUS: Record<FormTheme['rounded'], string> = {
  sharp: '0.25rem',
  soft: '0.625rem',
  pill: '9999px',
};

/**
 * The custom properties a themed form subtree runs on.
 *
 * Spread onto the wrapper's `style`. `--primary` and `--ring` are
 * overridden too, so every existing token-based control inside the
 * renderer picks the accent up without being rewritten.
 */
export function formThemeStyle(theme: FormTheme): React.CSSProperties {
  const accent = safeAccent(theme.accent);
  return {
    '--form-accent': accent,
    '--form-accent-fg': accentForeground(accent),
    '--form-radius': RADIUS[theme.rounded],
    '--primary': accent,
    '--primary-foreground': accentForeground(accent),
    '--ring': accent,
  } as React.CSSProperties;
}

/**
 * What to put in `data-form-scheme`.
 *
 * `system` resolves to `light` here and is corrected before paint by
 * FORM_SCHEME_BOOT_SCRIPT. Omitting the attribute instead would NOT mean
 * "follow the visitor" — the subtree would inherit `html[data-mode]`,
 * which for an anonymous visitor is the app's dark default. That is the
 * very bug this module exists to fix, so `system` has to be resolved
 * against the OS explicitly rather than by falling through.
 */
export function formSchemeAttr(theme: FormTheme): 'light' | 'dark' {
  return theme.color_scheme === 'dark' ? 'dark' : 'light';
}

/**
 * Resolves `system` against the OS before first paint.
 *
 * Rendered only when the owner chose `system`. Server-side that case is
 * marked `data-form-scheme="light"`, and this flips it to dark for a
 * visitor whose OS asks for dark — the same beforeInteractive trick the
 * root layout uses for the dashboard, and for the same reason: doing it
 * in an effect would paint the wrong scheme first.
 */
export const FORM_SCHEME_BOOT_SCRIPT = `
(function(){
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      var els = document.querySelectorAll('[data-form-scheme-auto]');
      for (var i = 0; i < els.length; i++) {
        els[i].setAttribute('data-form-scheme', 'dark');
      }
    }
  } catch (_e) {}
})();
`;
