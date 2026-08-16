import type { ComponentType } from 'react'

import { cn } from '@/lib/utils'
import type { MarkStyle } from '@/lib/analytics/config'

/**
 * The channel's identity mark at the top of an analytics page and on
 * its connect CTA.
 *
 * ⚠️ TWO RENDERINGS, BECAUSE THE ICONS ARE TWO DIFFERENT KINDS OF THING.
 * WhatsApp and Instagram are the official raster logos, which already
 * carry their own rounded-square tile and their own colour; painting a
 * brand-coloured square behind one makes it invisible (green on green).
 * Web is a lucide glyph in `currentColor`, which needs that tinted
 * square to read as a channel mark rather than a stray icon.
 *
 * `markStyle` on the channel's analytics config says which it is. It is
 * a declared fact rather than something inferred from the component,
 * because "does this icon paint itself?" is not answerable by looking
 * at a `ComponentType`.
 */
export function ChannelMark({
  icon: Icon,
  markStyle,
  accent,
  gradient,
  className,
}: {
  icon: ComponentType<{ className?: string }>
  markStyle: MarkStyle
  accent: string
  gradient?: string
  /** Box size, e.g. "h-10 w-10". */
  className?: string
}) {
  if (markStyle === 'logo') {
    return <Icon className={cn('shrink-0 rounded-xl', className)} />
  }

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl text-white',
        className,
      )}
      style={gradient ? { backgroundImage: gradient } : { backgroundColor: accent }}
    >
      {/* Roughly half the box, so the glyph sits in the tile the way the
          raster logos' own artwork does. */}
      <Icon className="h-1/2 w-1/2" />
    </span>
  )
}
