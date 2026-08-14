"use client"

import { useMemo } from "react"
import { useSearchParams } from "next/navigation"

import {
  AutomationBuilder,
  type BuilderInitial,
} from "@/components/automations/automation-builder"
import { draftToBuilderSeed, takeDraft } from "@/lib/automations/ai-draft"
import { templateToBuilderSeed } from "@/lib/automations/template-expand"
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "@/lib/automations/templates"
import type { AutomationTriggerType } from "@/types"

const EMPTY: BuilderInitial = {
  name: "",
  description: "",
  trigger_type: "new_message_received" as AutomationTriggerType,
  trigger_config: {},
  channels: [],
  is_active: false,
  steps: [],
}

export default function NewAutomationPage() {
  const params = useSearchParams()
  const template = params.get("template") as TemplateSlug | null
  const draftId = params.get("draft")

  const initial: BuilderInitial = useMemo(() => {
    // An AI draft wins over a template: `?draft=` is only ever set by the
    // AI builder navigating here, and `takeDraft` CONSUMES it — so this
    // memo must not re-run on anything that changes while the author is
    // editing, or their work is replaced by a draft that is now gone.
    if (draftId) {
      const draft = takeDraft(draftId)
      if (draft) return draftToBuilderSeed(draft)
      // The stash is per-tab and read-once, so a refresh or a shared link
      // lands here. A blank canvas is the honest outcome — silently
      // re-generating would spend credits nobody asked to spend.
      return EMPTY
    }

    if (template && AUTOMATION_TEMPLATES[template]) {
      return templateToBuilderSeed(AUTOMATION_TEMPLATES[template])
    }

    return EMPTY
  }, [template, draftId])

  return <AutomationBuilder initial={initial} />
}
