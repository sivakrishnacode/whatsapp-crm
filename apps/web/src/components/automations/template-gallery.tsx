'use client';

/**
 * The template gallery.
 *
 * WHY IT IS A PAGE AND NOT THE OLD FOUR-CARD STRIP
 *   The strip lived on the automations list and disappeared once you had
 *   three automations — precisely when you have learned enough to want a
 *   fifth. Two dozen templates also need search and grouping, which a
 *   strip has nowhere to put.
 *
 * REQUIREMENTS ARE ON THE CARD, RESOLVED LIVE
 *   See `use-template-readiness.ts`. A card that needs Google Sheets says
 *   so, and says whether THIS workspace has it, before the click.
 *   Requirements never BLOCK the click: a template you cannot run yet is
 *   still worth opening, and the builder is where the connect button and
 *   the pickers already live.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlarmClock,
  Bot,
  Braces,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  Check,
  ClipboardList,
  Clock,
  Flame,
  Globe,
  Heart,
  HelpCircle,
  LifeBuoy,
  Link2,
  Mail,
  MessageCircle,
  MessagesSquare,
  PhoneCall,
  Search,
  Shield,
  ShoppingCart,
  Sparkles,
  Star,
  Table2,
  Tags,
  Truck,
  Users,
} from 'lucide-react';

import { InstagramIcon } from '@/components/channels/channel-icons';
import type { NavIcon } from '@/lib/nav/channels';

import { Input } from '@/components/ui/input';
import {
  useGoogleBridgeSnapshot,
  useTemplateReadiness,
  type GoogleBridgeSnapshot,
  type ResolvedRequirement,
} from '@/hooks/use-template-readiness';
import {
  AUTOMATION_TEMPLATES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_SLUGS,
  type AutomationTemplateDefinition,
  type TemplateCategory,
  type TemplateSlug,
} from '@/lib/automations/templates';
import { cn } from '@/lib/utils';

/**
 * `NavIcon`, not `LucideIcon`: lucide-react 1.x dropped its brand icons,
 * so Instagram is the hand-rolled SVG the nav already uses. All this map
 * ever does is render with a `className`, which is exactly what NavIcon
 * promises — see the note on the type.
 */
const TEMPLATE_ICON: Record<TemplateSlug, NavIcon> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  weekend_autoresponder: AlarmClock,
  web_chat_greeting: Globe,
  lead_qualifier: Users,
  pricing_request_router: Tags,
  new_lead_to_sheet: Table2,
  form_submission_to_deal: ClipboardList,
  hot_lead_alert: Flame,
  vip_fast_lane: Star,
  instagram_comment_to_dm: InstagramIcon,
  instagram_story_reply_thanks: Heart,
  send_booking_link: CalendarClock,
  appointment_confirmation: CalendarCheck,
  appointment_reminder: AlarmClock,
  appointment_cancelled_recovery: CalendarX,
  support_triage: LifeBuoy,
  complaint_escalation: Shield,
  faq_autoresponder: HelpCircle,
  csat_survey: Sparkles,
  order_status_lookup: Truck,
  abandoned_cart_nudge: ShoppingCart,
  follow_up_reminder: PhoneCall,
  re_engagement_nudge: MessagesSquare,
  log_conversation_to_sheet: Table2,
  email_lead_summary: Mail,
  book_calendar_event: CalendarCheck,
};

/** Hue per category, so the grid reads as groups rather than confetti —
 *  the same argument `step-meta.tsx` makes for colouring by category. */
const CATEGORY_HUE: Record<TemplateCategory, string> = {
  greeting: 'oklch(0.62 0.13 162)',
  lead_capture: 'oklch(0.6 0.18 293)',
  appointments: 'oklch(0.68 0.13 225)',
  support: 'oklch(0.66 0.16 20)',
  commerce: 'oklch(0.72 0.15 65)',
  follow_up: 'oklch(0.65 0.15 350)',
  integrations: 'oklch(0.65 0.1 185)',
};

const ALL = 'all' as const;

export function TemplateGallery() {
  const router = useRouter();
  const snapshot = useGoogleBridgeSnapshot();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<TemplateCategory | typeof ALL>(ALL);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TEMPLATE_SLUGS.map((slug) => AUTOMATION_TEMPLATES[slug]).filter(
      (t) => {
        if (category !== ALL && t.category !== category) return false;
        if (!q) return true;
        // Searching the highlights too: people look for "no-show" and
        // "reschedule", which are on the card but not in the name.
        const haystack = [t.name, t.description, ...(t.highlights ?? [])]
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      }
    );
  }, [query, category]);

  const counts = useMemo(() => {
    const out = new Map<TemplateCategory, number>();
    for (const slug of TEMPLATE_SLUGS) {
      const c = AUTOMATION_TEMPLATES[slug].category;
      out.set(c, (out.get(c) ?? 0) + 1);
    }
    return out;
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            aria-label="Search templates"
            className="pl-9"
          />
        </div>
        <button
          type="button"
          onClick={() => router.push('/automations/ai')}
          className="border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 inline-flex items-center gap-2 self-start rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:self-auto"
        >
          <Bot className="h-4 w-4" />
          Nothing fits? Describe it to AI
        </button>
      </div>

      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label="Filter by category"
      >
        <FilterChip
          active={category === ALL}
          onClick={() => setCategory(ALL)}
          label="All"
          count={TEMPLATE_SLUGS.length}
        />
        {TEMPLATE_CATEGORIES.map((c) => (
          <FilterChip
            key={c.id}
            active={category === c.id}
            onClick={() => setCategory(c.id)}
            label={c.label}
            count={counts.get(c.id) ?? 0}
          />
        ))}
      </div>

      {matches.length === 0 ? (
        <div className="border-border bg-card/40 flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center">
          <Search className="text-muted-foreground h-6 w-6" />
          <p className="text-foreground mt-3 text-sm font-medium">
            No template matches “{query}”
          </p>
          <p className="text-muted-foreground mt-1 max-w-sm text-xs">
            Describe what you want to the AI builder instead — it writes the
            steps for you.
          </p>
          <button
            type="button"
            onClick={() => router.push('/automations/ai')}
            className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
          >
            <Bot className="h-4 w-4" />
            Build with AI
          </button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {matches.map((template) => (
            <TemplateCard
              key={template.slug}
              template={template}
              snapshot={snapshot}
              onUse={() =>
                router.push(`/automations/new?template=${template.slug}`)
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border bg-card text-muted-foreground hover:bg-muted'
      )}
    >
      {label}
      <span className="tabular-nums opacity-60">{count}</span>
    </button>
  );
}

function TemplateCard({
  template,
  snapshot,
  onUse,
}: {
  template: AutomationTemplateDefinition;
  snapshot: GoogleBridgeSnapshot;
  onUse: () => void;
}) {
  const requirements = useTemplateReadiness(template, snapshot);
  const Icon = TEMPLATE_ICON[template.slug] ?? Braces;
  const hue = CATEGORY_HUE[template.category];

  return (
    <li>
      <button
        type="button"
        onClick={onUse}
        className={cn(
          'border-border bg-card flex h-full w-full flex-col items-start rounded-xl border p-4 text-left transition-colors',
          'hover:border-primary/40 hover:bg-muted/30',
          'focus-visible:ring-primary/50 focus-visible:ring-2 focus-visible:outline-none'
        )}
      >
        <span className="flex w-full items-start gap-3">
          <span
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg"
            style={{
              background: `color-mix(in oklch, ${hue}, transparent 86%)`,
              color: `color-mix(in oklch, ${hue}, var(--foreground) 22%)`,
            }}
          >
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-foreground block text-sm font-semibold">
              {template.name}
            </span>
            <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">
              {template.description}
            </span>
          </span>
        </span>

        {template.highlights && template.highlights.length > 0 && (
          <span className="mt-3 flex flex-wrap gap-1.5">
            {template.highlights.map((h) => (
              <span
                key={h}
                className="border-border bg-muted/50 text-muted-foreground inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
              >
                {h}
              </span>
            ))}
          </span>
        )}

        <span className="text-muted-foreground mt-auto flex w-full items-center gap-2 pt-3 text-[11px]">
          <span className="tabular-nums">
            {template.steps.length} step{template.steps.length === 1 ? '' : 's'}
          </span>
          {requirements.length > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="flex flex-wrap gap-1.5">
                {requirements.map((r) => (
                  <RequirementBadge key={r.requirement.id} resolved={r} />
                ))}
              </span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * A requirement, in one badge.
 *
 * `manual` requirements are shown in the same neutral treatment as the
 * step count — they are information, not a problem. Only a `missing`
 * connection gets a warning tint, because that one has a fix the user
 * can act on right now.
 */
function RequirementBadge({ resolved }: { resolved: ResolvedRequirement }) {
  const { requirement, state, detail } = resolved;
  const label = requirement.label;

  const tone =
    state === 'ready'
      ? 'border-green-500/30 bg-green-500/10 text-accent-green'
      : state === 'missing'
        ? 'border-amber-500/30 bg-amber-500/10 text-accent-amber'
        : 'border-border bg-muted/50 text-muted-foreground';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium',
        tone
      )}
      title={detail ?? (state === 'ready' ? `${label} is connected` : label)}
    >
      {state === 'ready' ? (
        <Check className="h-3 w-3" />
      ) : requirement.kind === 'app' ? (
        <Link2 className="h-3 w-3" />
      ) : null}
      {state === 'checking' ? `${label}…` : label}
    </span>
  );
}
