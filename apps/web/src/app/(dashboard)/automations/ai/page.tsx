"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { AiAutomationBuilder } from "@/components/automations/ai-automation-builder"

export default function AiAutomationPage() {
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/automations"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Automations
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Build with AI
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe what should happen automatically. You&rsquo;ll get a draft to
          review and edit — nothing is created until you save it.
        </p>
      </div>

      <AiAutomationBuilder />
    </div>
  )
}
