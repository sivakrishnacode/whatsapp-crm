// ============================================================
// Tremor chartColors [v0.1.0] — copied from tremorlabs/tremor.
//
// The Tremor charts source uses these helpers to map a category
// name to a stable Tailwind color class (`bg-violet-500`,
// `fill-accent-blue`, …). Tremor's "Raw" distribution is copy-paste
// — there is no `@tremor/raw` npm package — so the canonical
// approach is to vendor the file unchanged and customise locally.
//
// Source: https://github.com/tremorlabs/tremor/blob/main/src/utils/chartColors.ts
// License: Apache 2.0 (Tremor)
// ============================================================

export type ColorUtility = "bg" | "stroke" | "fill" | "text"

export const chartColors = {
  blue: {
    bg: "bg-blue-500",
    stroke: "stroke-accent-blue",
    fill: "fill-accent-blue",
    text: "text-accent-blue",
  },
  emerald: {
    bg: "bg-green-500",
    stroke: "stroke-accent-green",
    fill: "fill-accent-green",
    text: "text-accent-green",
  },
  violet: {
    bg: "bg-violet-500",
    stroke: "stroke-accent-violet",
    fill: "fill-accent-violet",
    text: "text-accent-violet",
  },
  amber: {
    bg: "bg-amber-500",
    stroke: "stroke-accent-amber",
    fill: "fill-accent-amber",
    text: "text-accent-amber",
  },
  gray: {
    bg: "bg-muted",
    stroke: "stroke-muted-foreground",
    fill: "fill-muted-foreground",
    text: "text-muted-foreground",
  },
  cyan: {
    bg: "bg-cyan-500",
    stroke: "stroke-accent-cyan",
    fill: "fill-accent-cyan",
    text: "text-accent-cyan",
  },
  pink: {
    bg: "bg-pink-500",
    stroke: "stroke-accent-pink",
    fill: "fill-accent-pink",
    text: "text-accent-pink",
  },
  lime: {
    bg: "bg-green-500",
    stroke: "stroke-accent-green",
    fill: "fill-accent-green",
    text: "text-accent-green",
  },
  fuchsia: {
    bg: "bg-purple-500",
    stroke: "stroke-accent-purple",
    fill: "fill-accent-purple",
    text: "text-accent-purple",
  },
} as const satisfies {
  [color: string]: {
    [key in ColorUtility]: string
  }
}

export type AvailableChartColorsKeys = keyof typeof chartColors

export const AvailableChartColors: AvailableChartColorsKeys[] = Object.keys(
  chartColors,
) as Array<AvailableChartColorsKeys>

export const constructCategoryColors = (
  categories: string[],
  colors: AvailableChartColorsKeys[],
): Map<string, AvailableChartColorsKeys> => {
  const categoryColors = new Map<string, AvailableChartColorsKeys>()
  categories.forEach((category, index) => {
    categoryColors.set(category, colors[index % colors.length])
  })
  return categoryColors
}

export const getColorClassName = (
  color: AvailableChartColorsKeys,
  type: ColorUtility,
): string => {
  const fallbackColor = {
    bg: "bg-muted",
    stroke: "stroke-muted-foreground",
    fill: "fill-muted-foreground",
    text: "text-muted-foreground",
  }
  return chartColors[color]?.[type] ?? fallbackColor[type]
}
