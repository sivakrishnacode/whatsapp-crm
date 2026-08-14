"use client"

/**
 * The fork in the road after "Create Automation".
 *
 * THREE ROUTES, NOT A WIZARD
 *   They are genuinely different starting points, not steps: an author
 *   either knows the shape they want (scratch), recognises it in a list
 *   (template), or can only describe it in a sentence (AI). Making one
 *   the default and burying the others is how the template gallery ended
 *   up as four cards that vanished once you had three automations.
 *
 * Each route navigates to its own page rather than opening a nested
 * dialog: the gallery needs search, filters and scroll, and the AI
 * composer needs room to show its working. Both are deep-linkable, which
 * a dialog inside a dialog would not be.
 */

import { useRouter } from "next/navigation"
import { Bot, LayoutGrid, PenLine, type LucideIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TEMPLATE_SLUGS } from "@/lib/automations/templates"
import { cn } from "@/lib/utils"

interface RouteOption {
  id: string
  title: string
  blurb: string
  meta: string
  href: string
  icon: LucideIcon
  /** oklch hue for the icon chip — matches the step-meta palette. */
  hue: string
  featured?: boolean
}

const OPTIONS: RouteOption[] = [
  {
    id: "scratch",
    title: "Start from scratch",
    blurb:
      "An empty canvas. Pick your own trigger and add steps one at a time.",
    meta: "Full control",
    href: "/automations/new",
    icon: PenLine,
    hue: "oklch(0.68 0.13 225)",
  },
  {
    id: "templates",
    title: "Use a template",
    blurb:
      "Proven workflows with the copy already written — greetings, triage, follow-ups, integrations.",
    meta: `${TEMPLATE_SLUGS.length} templates`,
    href: "/automations/templates",
    icon: LayoutGrid,
    hue: "oklch(0.6 0.18 293)",
  },
  {
    id: "ai",
    title: "Build with AI",
    blurb:
      "Describe what should happen in a sentence and get a draft automation you can edit.",
    meta: "Uses AI credits",
    href: "/automations/ai",
    icon: Bot,
    hue: "oklch(0.62 0.13 162)",
    featured: true,
  },
]

export function CreateAutomationDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()

  function go(href: string) {
    onOpenChange(false)
    router.push(href)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create an automation</DialogTitle>
          <DialogDescription>
            How would you like to start?
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          {OPTIONS.map((option) => (
            <RouteCard key={option.id} option={option} onSelect={() => go(option.href)} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RouteCard({
  option,
  onSelect,
}: {
  option: RouteOption
  onSelect: () => void
}) {
  const Icon = option.icon
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex h-full flex-col items-start rounded-xl border border-border bg-card p-4 text-left transition-colors",
        "hover:border-primary/50 hover:bg-muted/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
      )}
    >
      <span
        className="flex h-9 w-9 items-center justify-center rounded-lg"
        style={{
          // `line` rather than the raw hue: a raw oklch glyph measures
          // under WCAG 1.4.11's 3:1 on a light card. Same derivation as
          // `stepColors()` in step-meta.
          background: `color-mix(in oklch, ${option.hue}, transparent 86%)`,
          color: `color-mix(in oklch, ${option.hue}, var(--foreground) 22%)`,
        }}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>

      <span className="mt-3 text-sm font-semibold text-foreground">
        {option.title}
      </span>
      <span className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">
        {option.blurb}
      </span>
      <span
        className={cn(
          "mt-3 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
          option.featured
            ? "border-primary/30 bg-primary/10 text-primary"
            : "border-border bg-muted/50 text-muted-foreground",
        )}
      >
        {option.meta}
      </span>
    </button>
  )
}
