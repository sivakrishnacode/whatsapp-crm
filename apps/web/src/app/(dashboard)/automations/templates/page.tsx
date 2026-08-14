"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { TemplateGallery } from "@/components/automations/template-gallery"

export default function AutomationTemplatesPage() {
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
        <h1 className="mt-2 text-2xl font-bold text-foreground">Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a starting point. Every template opens in the builder with its
          copy already written — nothing is created until you save.
        </p>
      </div>

      <TemplateGallery />
    </div>
  )
}
