import {
  BarChart3,
  Bot,
  Inbox,
  Plug,
  ShoppingBag,
  Sparkles,
  Target,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * The wizard's answer vocabularies.
 *
 * The keys MUST match the arrays in
 * `apps/api/src/onboarding/dto/onboarding.dto.ts` — the API validates
 * against them with @IsIn and rejects anything it doesn't recognise, so
 * a key that drifts here surfaces as a 400 on the last step of signup.
 * Labels are display-only and can change freely.
 */

export interface GoalOption {
  key: string;
  label: string;
  icon: LucideIcon;
}

export const GOAL_OPTIONS: readonly GoalOption[] = [
  { key: "shared_inbox", label: "Shared team inbox", icon: Inbox },
  { key: "broadcasts", label: "Broadcasts & campaigns", icon: BarChart3 },
  { key: "automations", label: "Automations & chatbots", icon: Bot },
  { key: "flows", label: "Interactive flows", icon: Workflow },
  { key: "pipeline", label: "Deals & pipeline", icon: Target },
  { key: "ecommerce", label: "Catalogue & orders", icon: ShoppingBag },
  { key: "ai_assistant", label: "AI assistant", icon: Sparkles },
  { key: "api_integrations", label: "API & integrations", icon: Plug },
] as const;

export interface ChoiceOption {
  key: string;
  label: string;
}

export const TEAM_SIZE_OPTIONS: readonly ChoiceOption[] = [
  { key: "1", label: "Just me" },
  { key: "2-5", label: "2–5" },
  { key: "6-20", label: "6–20" },
  { key: "21-50", label: "21–50" },
  { key: "50+", label: "50+" },
] as const;

export const REFERRAL_OPTIONS: readonly ChoiceOption[] = [
  { key: "google", label: "Google search" },
  { key: "referral", label: "A friend or colleague" },
  { key: "social", label: "Social media" },
  { key: "whatsapp_group", label: "A WhatsApp group" },
  { key: "event", label: "An event or webinar" },
  { key: "other", label: "Somewhere else" },
] as const;

/** The one referral answer that opens a free-text field. */
export const REFERRAL_OTHER_KEY = "other";
