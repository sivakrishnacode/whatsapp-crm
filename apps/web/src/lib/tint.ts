import type { CSSProperties } from 'react';

/**
 * Hand a user-chosen colour to the `.tint-chip` / `.tint-mark` classes.
 *
 * Tags, segments and pipeline stages carry a hex from the database, so
 * their hue can't come from a token — but how that hue is rendered still
 * has to change between modes. The stylesheet does that (see the TINTS
 * block in globals.css); all this does is deliver the hue.
 *
 * Use it INSTEAD of `style={{ backgroundColor: color + '20', color }}`,
 * which is legible on dark and roughly 2:1 on light.
 *
 *   <span className="tint-chip border ..." style={tint(tag.color)}>
 *
 * A missing colour falls back to the neutral token rather than to
 * `transparent`: half the rows in a list carry no colour at all, and an
 * invisible chip reads as a broken one.
 */
export function tint(color: string | null | undefined): CSSProperties {
  return {
    '--tint': color?.trim() || 'var(--muted-foreground)',
  } as CSSProperties;
}
