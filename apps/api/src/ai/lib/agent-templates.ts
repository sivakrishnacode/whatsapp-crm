import { AGENT_SKILL_IDS } from './skills';
import type { AgentSkills } from './types';

/**
 * ============================================================
 * Role templates — the starting points offered by "New agent".
 *
 * A template is a set of DEFAULTS, not a type. Once created, an agent
 * from a template is an ordinary agent with no memory of where it came
 * from: there is no template id on the row, nothing re-applies an
 * updated template later, and every field stays editable. That is the
 * whole contract, and it is why a template can be changed here without a
 * migration and without touching anybody's existing agent.
 *
 * Each one answers three questions and nothing else — who it is, what it
 * must never do, and which skills it needs — because those are the three
 * a business cannot infer from an empty form. Deliberately absent:
 * `channels` (routing is a decision about THEIR channels, not ours) and
 * `auto_reply_enabled` (a template must never switch on answering
 * customers by itself).
 * ============================================================
 */

export interface AgentTemplate {
  id: string;
  label: string;
  /** One line, shown under the label in the picker. */
  description: string;
  /** Lucide icon name; the web app maps it to a component. */
  icon: string;
  /** Suggested list name. Made unique per workspace on create. */
  name: string;
  tone: 'friendly' | 'professional' | 'concise' | 'playful';
  responseLength: 'short' | 'medium' | 'long';
  groundRules: string;
  /** Skill ids switched on. Everything else keeps its registry default. */
  skills: string[];
  handoffEnabled: boolean;
  handoffTriggerPhrases: string[];
  handoffMessage: string | null;
  fallbackMessage: string | null;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'support',
    label: 'Customer support',
    description:
      'Answers questions from your knowledge base and hands over anything it cannot source.',
    icon: 'LifeBuoy',
    name: 'Support',
    tone: 'friendly',
    responseLength: 'medium',
    groundRules: [
      'Answer only from the knowledge base and the business description. If the answer is not there, say so and offer to have a colleague follow up.',
      'Never invent prices, delivery dates, stock levels or policy details.',
      'Never promise a refund, discount or exception — take the details and hand over.',
    ].join('\n'),
    skills: ['faq', 'human_handoff'],
    handoffEnabled: true,
    handoffTriggerPhrases: ['human', 'agent', 'talk to someone', 'complaint'],
    handoffMessage:
      'Let me get a colleague to help with this — someone will reply here shortly.',
    fallbackMessage:
      'Sorry, I could not reach that just now. Someone from the team will follow up here.',
  },
  {
    id: 'sales',
    label: 'Sales assistant',
    description:
      'Qualifies new enquiries, answers product questions and books the next step.',
    icon: 'TrendingUp',
    name: 'Sales',
    tone: 'friendly',
    responseLength: 'short',
    groundRules: [
      'Find out what the customer needs before recommending anything.',
      'Quote only prices that appear in the knowledge base, and always state the currency.',
      'Never discount, never promise a delivery date, never commit to a custom scope — hand over instead.',
      'One question at a time. This is a chat, not a form.',
    ].join('\n'),
    skills: [
      'faq',
      'lead_qualification',
      'product_recommendations',
      'human_handoff',
    ],
    handoffEnabled: true,
    handoffTriggerPhrases: ['human', 'sales team', 'call me', 'quote'],
    handoffMessage:
      'I will pass this to the team so they can put a proper quote together for you.',
    fallbackMessage: null,
  },
  {
    id: 'bookings',
    label: 'Appointments',
    description:
      'Takes booking requests, states availability and shares your booking link.',
    icon: 'CalendarClock',
    name: 'Bookings',
    tone: 'friendly',
    responseLength: 'short',
    groundRules: [
      'Confirm the service, the date and the time in every reply that moves a booking forward.',
      'Never confirm a slot as booked unless a tool has confirmed it. Say it is requested.',
      'State opening hours and the timezone whenever times are discussed.',
    ].join('\n'),
    skills: ['appointments', 'faq', 'human_handoff'],
    handoffEnabled: true,
    handoffTriggerPhrases: ['human', 'reschedule', 'cancel', 'emergency'],
    handoffMessage:
      'I will get someone from the team to sort this booking out with you directly.',
    fallbackMessage: null,
  },
  {
    id: 'orders',
    label: 'Order tracking',
    description:
      'Looks up an order, reports its status and explains the returns policy.',
    icon: 'PackageSearch',
    name: 'Order tracking',
    tone: 'concise',
    responseLength: 'short',
    groundRules: [
      'Ask for the order number before looking anything up. Never guess which order they mean.',
      'Report only what the lookup returned — never estimate where a parcel is.',
      'If the lookup fails, say you could not check and hand over rather than reassuring them.',
    ].join('\n'),
    skills: ['order_status', 'returns', 'faq', 'human_handoff'],
    handoffEnabled: true,
    handoffTriggerPhrases: ['human', 'refund', 'damaged', 'wrong item'],
    handoffMessage:
      'Let me get a colleague to look into this order with you properly.',
    fallbackMessage:
      'I could not reach the order system just now. Someone will check this and reply here.',
  },
  {
    id: 'lead_qualifier',
    label: 'Lead qualifier',
    description:
      'Collects the details your team needs before a human ever picks the conversation up.',
    icon: 'UserCheck',
    name: 'Lead qualifier',
    tone: 'professional',
    responseLength: 'short',
    groundRules: [
      'Collect the qualifying details one question at a time, then summarise them back.',
      'Never quote a price, a timeline or a scope — that is the team’s job once they have the details.',
      'Stop asking and hand over as soon as the customer says they want to speak to someone.',
    ].join('\n'),
    skills: ['lead_qualification', 'faq', 'human_handoff'],
    handoffEnabled: true,
    handoffTriggerPhrases: ['human', 'call me', 'speak to someone'],
    handoffMessage:
      'Thanks — I have everything I need. Someone from the team will pick this up shortly.',
    fallbackMessage: null,
  },
];

export function findAgentTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id);
}

/**
 * A template's skill list as the `skills` column stores it.
 *
 * Every registry id is written explicitly, including the ones the
 * template leaves off: a skill absent from the column falls back to its
 * registry `defaultEnabled`, so "not mentioned" would quietly mean "on"
 * for `faq` and `human_handoff`. A template that says which skills it
 * wants should get exactly those.
 */
export function templateSkills(template: AgentTemplate): AgentSkills {
  const skills: AgentSkills = {};
  for (const id of AGENT_SKILL_IDS) {
    skills[id] = { enabled: template.skills.includes(id), config: {} };
  }
  return skills;
}
