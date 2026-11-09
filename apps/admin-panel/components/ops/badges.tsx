import { Pill, type Tone } from '@/components/ui/badge';
import type { HealthState } from '@/lib/health/rules';
import type { LifecycleStage } from '@/lib/lifecycle';
import type { Severity } from '@/lib/settings';
import type { SlaClock, TicketStatus } from '@/lib/sla';

/**
 * The Control Center's state vocabulary, rendered one way everywhere.
 * Each pill pairs a shape glyph with a word — never colour alone.
 */

export const HEALTH_STYLE: Record<
  HealthState,
  { tone: Tone; label: string; glyph: string }
> = {
  healthy: { tone: 'good', label: 'Healthy', glyph: '●' },
  attention: { tone: 'warn', label: 'Attention', glyph: '▲' },
  critical: { tone: 'bad', label: 'Critical', glyph: '■' },
  // "Unknown" rather than "Checking": nothing is in flight — the evidence is
  // missing or stale, and the word should not suggest a result is coming.
  unknown: { tone: 'info', label: 'Unknown', glyph: '?' },
  not_configured: { tone: 'neutral', label: 'Not configured', glyph: '○' },
};

export function HealthBadge({
  state,
  title,
}: {
  state: HealthState;
  title?: string;
}) {
  const style = HEALTH_STYLE[state];
  return (
    <Pill tone={style.tone} glyph={style.glyph} title={title}>
      {style.label}
    </Pill>
  );
}

export const LIFECYCLE_STYLE: Record<
  LifecycleStage,
  { tone: Tone; label: string; glyph: string }
> = {
  lead: { tone: 'neutral', label: 'Lead', glyph: '◇' },
  onboarding: { tone: 'info', label: 'Onboarding', glyph: '◐' },
  active: { tone: 'good', label: 'Active', glyph: '●' },
  attention: { tone: 'warn', label: 'Attention', glyph: '▲' },
  suspended: { tone: 'bad', label: 'Suspended', glyph: '‖' },
  churned: { tone: 'bad', label: 'Churned', glyph: '■' },
  archived: { tone: 'neutral', label: 'Archived', glyph: '□' },
};

export function LifecycleBadge({
  stage,
  pinned,
  title,
}: {
  stage: LifecycleStage;
  pinned?: boolean;
  title?: string;
}) {
  const style = LIFECYCLE_STYLE[stage];
  return (
    <Pill tone={style.tone} glyph={style.glyph} title={title}>
      {style.label}
      {pinned ? (
        <span className="font-normal opacity-80"> · pinned</span>
      ) : null}
    </Pill>
  );
}

export const SEVERITY_STYLE: Record<
  Severity,
  { tone: Tone; label: string; glyph: string }
> = {
  critical: { tone: 'bad', label: 'Critical', glyph: '■' },
  high: { tone: 'warn', label: 'High', glyph: '▲' },
  normal: { tone: 'info', label: 'Normal', glyph: '●' },
  low: { tone: 'neutral', label: 'Low', glyph: '○' },
};

export function SeverityBadge({ severity }: { severity: string }) {
  const style = SEVERITY_STYLE[severity as Severity] ?? SEVERITY_STYLE.normal;
  return (
    <Pill tone={style.tone} glyph={style.glyph}>
      {style.label}
    </Pill>
  );
}

export const TICKET_STATUS_STYLE: Record<
  TicketStatus,
  { tone: Tone; label: string; glyph: string }
> = {
  open: { tone: 'info', label: 'Open', glyph: '○' },
  in_progress: { tone: 'primary', label: 'In progress', glyph: '◐' },
  waiting_customer: {
    tone: 'neutral',
    label: 'Waiting on customer',
    glyph: '…',
  },
  escalated: { tone: 'warn', label: 'Escalated', glyph: '▲' },
  resolved: { tone: 'good', label: 'Resolved', glyph: '●' },
  closed: { tone: 'neutral', label: 'Closed', glyph: '□' },
};

export function TicketStatusBadge({ status }: { status: string }) {
  const style =
    TICKET_STATUS_STYLE[status as TicketStatus] ?? TICKET_STATUS_STYLE.open;
  return (
    <Pill tone={style.tone} glyph={style.glyph}>
      {style.label}
    </Pill>
  );
}

export function SlaBadge({ clock }: { clock: SlaClock }) {
  const tone: Tone =
    clock.state === 'breached'
      ? 'bad'
      : clock.state === 'due_soon'
        ? 'warn'
        : clock.state === 'met'
          ? 'good'
          : 'neutral';
  const glyph =
    clock.state === 'breached'
      ? '■'
      : clock.state === 'due_soon'
        ? '▲'
        : clock.state === 'met'
          ? '●'
          : '◷';
  return (
    <Pill tone={tone} glyph={glyph}>
      {clock.label}
    </Pill>
  );
}

export const TIER_LABEL: Record<string, string> = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  billing: 'Billing',
};

export const CATEGORY_LABEL: Record<string, string> = {
  onboarding: 'Onboarding',
  meta_channel: 'Meta / channel',
  messaging: 'Messaging',
  templates: 'Templates',
  ai: 'AI',
  billing: 'Billing',
  api_integration: 'API / integration',
  account: 'Account',
  other: 'Other',
};

export const SOURCE_LABEL: Record<string, string> = {
  staff: 'Staff',
  phone: 'Phone',
  email: 'Email',
  whatsapp: 'WhatsApp',
  monitoring: 'Monitoring',
  onboarding: 'Onboarding',
  portal: 'Portal',
  mobile: 'Mobile app',
};

export const SERVICE_TIER_LABEL: Record<string, string> = {
  standard: 'Standard',
  priority: 'Priority',
  enterprise: 'Enterprise',
};
