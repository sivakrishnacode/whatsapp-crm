/**
 * The tiny trend line inside a KPI tile.
 *
 * Deliberately unlabelled and unhoverable: it answers "which way is
 * this going?" at a glance and nothing more. Anyone who wants the
 * numbers has the full chart directly below. Axes, ticks and tooltips
 * at this size are noise that makes the tile harder to scan, not
 * easier.
 */
export function Sparkline({
  values,
  color,
  className,
  height = 28,
}: {
  values: number[]
  color: string
  className?: string
  height?: number
}) {
  // Two points is the minimum that can express a direction. One point
  // is a dot, and a dot in a trend slot reads as a rendering bug.
  if (values.length < 2) return <div style={{ height }} className={className} aria-hidden />

  const W = 100
  const H = 30
  const max = Math.max(...values)
  const min = Math.min(...values)
  // A flat series would divide by zero; draw it as a centred straight
  // line rather than collapsing it onto the baseline, which would
  // look like a series that fell to zero.
  const span = max - min || 1
  const stepX = W / (values.length - 1)

  const points = values.map((v, i) => {
    const x = i * stepX
    const y = max === min ? H / 2 : H - ((v - min) / span) * H
    return [x, y] as const
  })

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `${line} L${W},${H} L0,${H} Z`
  const gradientId = `spark-${color.replace(/[^a-z0-9]/gi, '')}`

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height }}
      className={className}
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      {/* vectorEffect keeps the stroke 1.5px after the non-uniform
          scale that preserveAspectRatio="none" applies. */}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
