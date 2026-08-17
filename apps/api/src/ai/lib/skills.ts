import type { AgentSkillState, AgentSkills } from './types';

/**
 * ============================================================
 * Skill registry — the jobs the agent is allowed to do.
 *
 * A skill is two things: a paragraph appended to the system prompt, and
 * (optionally) the built-in tools it unlocks. Nothing else. The account
 * row stores only `{ enabled, config }` per id (`ai_configs.skills`),
 * exactly like the ad-type registry in `src/ads/services/ad-types` —
 * the code owns the list, the row owns which are on. Adding a skill is
 * one entry here and zero migrations.
 *
 * WHY SKILLS AT ALL, WHEN THE PROMPT IS ALREADY EDITABLE
 *   Because "answer FAQs but never quote a price" and "collect a lead"
 *   are decisions, not prose. Enumerated, they can be toggled, audited
 *   and — critically — attached to tools. A free-text prompt cannot
 *   grant the model access to the order table.
 *
 * ORDER MATTERS: prompt fragments are emitted in registry order, so the
 * routing rule ("pick the skill that fits") reads top-down the same way
 * the UI lists them.
 * ============================================================
 */

export type SkillFieldType = 'text' | 'textarea' | 'url' | 'list';

export interface SkillConfigField {
  key: string;
  label: string;
  type: SkillFieldType;
  placeholder?: string;
  help?: string;
  /** `list` fields: cap on entries, so a config can't grow unbounded. */
  maxItems?: number;
  maxLength?: number;
}

export interface SkillDefinition {
  id: string;
  label: string;
  /** One line, shown in the UI. */
  description: string;
  defaultEnabled: boolean;
  /** Built-in tool names this skill unlocks (see `lib/tools/builtin.ts`). */
  tools: string[];
  config: SkillConfigField[];
  /**
   * The prompt fragment. Receives the saved config so a skill can teach
   * the model account-specific facts (which fields to collect, which
   * link to share) without a second prompt field.
   */
  prompt: (config: Record<string, unknown>) => string;
}

/** Read a `list` config value defensively — it comes from JSONB. */
export function skillList(
  config: Record<string, unknown>,
  key: string,
): string[] {
  const raw = config?.[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function skillText(
  config: Record<string, unknown>,
  key: string,
): string | null {
  const raw = config?.[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export const AGENT_SKILLS: SkillDefinition[] = [
  {
    id: 'faq',
    label: 'FAQ & support',
    description:
      'Answers general questions about the business from the knowledge base — products, hours, policies, delivery areas.',
    defaultEnabled: true,
    tools: [],
    config: [],
    prompt: () =>
      'FAQ & support: answer general questions about the business — what it sells, opening hours, policies, delivery areas, "do you do X". ' +
      'Answer only from the knowledge base and the business profile above. If they do not cover it, say you will check rather than inventing an answer.',
  },
  {
    id: 'lead_qualification',
    label: 'Lead qualification',
    description:
      'Collects the details you need from a new enquiry and saves them onto the contact.',
    defaultEnabled: false,
    tools: ['save_lead_details'],
    config: [
      {
        key: 'fields',
        label: 'Details to collect',
        type: 'list',
        placeholder: 'e.g. budget',
        help: 'Asked one or two at a time, never as a form.',
        maxItems: 8,
        maxLength: 60,
      },
      {
        key: 'qualified_when',
        label: 'Treat as qualified when',
        type: 'textarea',
        placeholder: 'e.g. they have a budget over ₹50,000 and a timeline this quarter',
        maxLength: 500,
      },
    ],
    prompt: (config) => {
      const fields = skillList(config, 'fields');
      const qualified = skillText(config, 'qualified_when');
      const parts = [
        'Lead qualification: when someone shows buying intent, find out what the business needs to know before a human follows up.',
      ];
      if (fields.length > 0) {
        parts.push(
          `Collect: ${fields.join(', ')}. Ask for at most two of these per message, conversationally — never send a numbered form.`,
        );
      }
      if (qualified) parts.push(`Treat the lead as qualified when: ${qualified}.`);
      parts.push(
        'Once you have the details, call `save_lead_details` exactly once to record them, then confirm to the customer that someone will follow up.',
      );
      return parts.join(' ');
    },
  },
  {
    id: 'order_status',
    label: 'Order status',
    description:
      'Looks up this customer’s own orders and reports status, total and items.',
    defaultEnabled: false,
    tools: ['lookup_orders'],
    config: [],
    prompt: () =>
      'Order status: when the customer asks about an order, delivery or refund of theirs, call `lookup_orders` before answering. ' +
      'It returns only orders belonging to this customer — never claim an order exists if the tool returned none; ask them to check the number instead. ' +
      'Report status, total and items plainly, and do not promise a delivery date the tool did not give you.',
  },
  {
    id: 'product_recommendations',
    label: 'Product recommendations',
    description:
      'Searches your catalogue and recommends matching products with real prices.',
    defaultEnabled: false,
    tools: ['search_products'],
    config: [],
    prompt: () =>
      'Product recommendations: when the customer describes what they want, call `search_products` and recommend from what it returns. ' +
      'Quote only the prices the tool gives you, at most three products per message, and say plainly when nothing matches instead of suggesting a substitute you invented.',
  },
  {
    id: 'returns',
    label: 'Returns & refunds',
    description:
      'Handles return, exchange and refund requests strictly by your policy.',
    defaultEnabled: false,
    tools: [],
    config: [
      {
        key: 'window_days',
        label: 'Return window (days)',
        type: 'text',
        placeholder: '14',
        maxLength: 4,
      },
      {
        key: 'policy_notes',
        label: 'Policy notes',
        type: 'textarea',
        placeholder: 'e.g. unopened items only, original packaging, customer pays return shipping',
        maxLength: 1000,
      },
    ],
    prompt: (config) => {
      const days = skillText(config, 'window_days');
      const notes = skillText(config, 'policy_notes');
      const parts = [
        'Returns & refunds: handle return, exchange and refund requests by the policy below and nothing else.',
      ];
      if (days) parts.push(`The return window is ${days} days from delivery.`);
      if (notes) parts.push(`Policy: ${notes}`);
      parts.push(
        'Never approve a refund, waive a fee or commit to a timeline yourself — explain the policy and, if the request falls outside it, hand it to a human.',
      );
      return parts.join(' ');
    },
  },
  {
    id: 'appointments',
    label: 'Appointments',
    description:
      'Shares your booking link and explains availability instead of guessing at slots.',
    defaultEnabled: false,
    tools: [],
    config: [
      {
        key: 'booking_url',
        label: 'Booking link',
        type: 'url',
        placeholder: 'https://…',
        help: 'Paste a Converse360 booking page or any external scheduler.',
        maxLength: 500,
      },
      {
        key: 'availability',
        label: 'Availability in words',
        type: 'textarea',
        placeholder: 'e.g. Mon–Fri 10:00–18:00 IST, closed on public holidays',
        maxLength: 500,
      },
    ],
    prompt: (config) => {
      const url = skillText(config, 'booking_url');
      const availability = skillText(config, 'availability');
      const parts = [
        'Appointments: when the customer wants to book, meet or visit, help them book.',
      ];
      if (availability) parts.push(`Availability: ${availability}.`);
      if (url) {
        parts.push(
          `Send this exact booking link when they are ready: ${url}. Do not shorten, alter or invent a different link.`,
        );
      }
      parts.push(
        'You cannot see the live calendar, so never confirm a specific slot as booked — the booking page does that.',
      );
      return parts.join(' ');
    },
  },
  {
    id: 'human_handoff',
    label: 'Human handoff',
    description:
      'Recognises when to stop and pass the conversation to your team.',
    defaultEnabled: true,
    tools: [],
    config: [],
    prompt: () =>
      'Human handoff: hand over when the customer asks for a person, is upset or complaining, raises anything sensitive (billing dispute, fraud, legal, health), ' +
      'or wants something no other skill above covers. Hand over cleanly — do not use it as an escape from a question you have not tried to answer.',
  },
  {
    id: 'create_deal',
    label: 'Deal creation',
    description:
      'Creates deals in your CRM pipeline based on conversation context and customer intent.',
    defaultEnabled: false,
    tools: ['create_deal'],
    config: [
      {
        key: 'deal_pipeline_id',
        label: 'Default pipeline ID',
        type: 'text',
        placeholder: 'Leave empty to let humans choose',
        help: 'Optional: paste a specific pipeline ID to auto-route all deals.',
        maxLength: 100,
      },
      {
        key: 'deal_stage_id',
        label: 'Default stage ID',
        type: 'text',
        placeholder: 'Leave empty to start at first stage',
        help: 'Optional: paste a specific stage ID for default placement.',
        maxLength: 100,
      },
      {
        key: 'auto_create_threshold',
        label: 'Deal intent confidence threshold',
        type: 'text',
        placeholder: '0.7',
        help: 'Minimum confidence (0-1) before automatically creating a deal. Defaults to 0.8.',
        maxLength: 5,
      },
    ],
    prompt: (config) => {
      const threshold = skillText(config, 'auto_create_threshold') || '0.8';
      return (
        'Deal creation: when a customer discusses a potential opportunity or project that fits your business, ' +
        `consider creating a deal if you are at least ${threshold} confident they are serious. ` +
        'Extract: the deal name from what they said, their likely budget or deal size, and any timeline they mentioned. ' +
        'Call `create_deal` once with a title, a value if they named one, and the requirements in `notes` — ' +
        'do not ask follow-up questions first, and do not ask for or invent a pipeline or stage id: ' +
        'the workspace default is chosen for you. ' +
        'If they later change their budget or requirements in this same conversation, call ' +
        '`create_deal` again with the new figure — it updates the deal this conversation already ' +
        'has instead of opening a second one, so never tell someone their change is noted ' +
        'without making that call. ' +
        'Confirm that the deal was recorded, then carry on the conversation naturally.'
      );
    },
  },
  {
    id: 'assign_deal_to_member',
    label: 'Deal assignment',
    description:
      'Assigns deals to specific team members based on ownership or expertise.',
    defaultEnabled: false,
    tools: ['assign_deal'],
    config: [
      {
        key: 'assignment_criteria',
        label: 'How to assign deals',
        type: 'textarea',
        placeholder: 'e.g. assign to the sales director for deals over 50k, to team leads otherwise',
        help: 'Guidance for which team member should own each deal.',
        maxLength: 500,
      },
    ],
    prompt: (config) => {
      const criteria = skillText(config, 'assignment_criteria');
      let prompt =
        'Deal assignment: after creating a deal or when a customer requests a specific contact, ' +
        'assign it to the right team member using `assign_deal` — name them the way you would ' +
        'out loud ("Priya", or their email). You do not need any id: leave `deal_id` out and the ' +
        "customer's newest open deal is used. ";
      if (criteria) {
        prompt += `Assignment rules: ${criteria}. `;
      }
      prompt +=
        'Do not mention internal team structure to the customer — simply confirm "your account manager will follow up."';
      return prompt;
    },
  },
  {
    id: 'trigger_automation',
    label: 'Automation triggers',
    description:
      'Triggers workflows and automations based on conversation events.',
    defaultEnabled: false,
    tools: ['trigger_automation'],
    config: [
      {
        key: 'automation_types',
        label: 'Available automation triggers',
        type: 'list',
        placeholder: 'e.g. send_email, update_contact, create_task',
        help: 'Types of automations this agent is permitted to trigger.',
        maxItems: 10,
        maxLength: 60,
      },
    ],
    prompt: (config) => {
      const types = skillList(config, 'automation_types');
      let prompt = 'Automation triggers: when a customer event warrants an internal action, ';
      if (types.length > 0) {
        prompt += `call \`trigger_automation\` to run: ${types.join(', ')}. `;
      } else {
        prompt += 'call `trigger_automation` to run configured automations. ';
      }
      prompt +=
        'Only trigger automations the customer explicitly requested or that directly serve their stated need — do not auto-trigger speculatively.';
      return prompt;
    },
  },
];

export const AGENT_SKILL_IDS: string[] = AGENT_SKILLS.map((s) => s.id);

export function findSkill(id: string): SkillDefinition | undefined {
  return AGENT_SKILLS.find((s) => s.id === id);
}

/**
 * Merge the stored per-skill state onto the registry, applying
 * `defaultEnabled` for any skill the row has never mentioned.
 *
 * Unknown ids in the row are dropped: a skill removed from the registry
 * must stop influencing prompts, and keeping its state around would
 * silently resurrect it if the id were ever reused.
 */
export function resolveSkills(stored: AgentSkills | null | undefined): AgentSkills {
  const out: AgentSkills = {};
  for (const skill of AGENT_SKILLS) {
    const raw = stored?.[skill.id];
    const config =
      raw && typeof raw.config === 'object' && raw.config !== null
        ? (raw.config as Record<string, unknown>)
        : {};
    out[skill.id] = {
      enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : skill.defaultEnabled,
      config,
    };
  }
  return out;
}

export function enabledSkills(skills: AgentSkills): Array<{
  definition: SkillDefinition;
  state: AgentSkillState;
}> {
  const resolved = resolveSkills(skills);
  return AGENT_SKILLS.filter((s) => resolved[s.id]?.enabled).map((definition) => ({
    definition,
    state: resolved[definition.id],
  }));
}

/** Built-in tool names unlocked by the enabled skills, de-duplicated. */
export function enabledSkillTools(skills: AgentSkills): string[] {
  const names = new Set<string>();
  for (const { definition } of enabledSkills(skills)) {
    for (const tool of definition.tools) names.add(tool);
  }
  return Array.from(names);
}

/**
 * Sanitize a skills payload from the client: only known ids, only known
 * config keys, strings trimmed and length-capped, lists bounded. The
 * result goes straight into JSONB, so this is the only thing standing
 * between a request body and the prompt.
 */
export function sanitizeSkills(input: unknown): AgentSkills {
  const out: AgentSkills = {};
  const raw = (input ?? {}) as Record<string, unknown>;

  for (const skill of AGENT_SKILLS) {
    const entry = raw[skill.id] as Record<string, unknown> | undefined;
    const enabled =
      typeof entry?.enabled === 'boolean' ? entry.enabled : skill.defaultEnabled;
    const inputConfig = (entry?.config ?? {}) as Record<string, unknown>;
    const config: Record<string, unknown> = {};

    for (const field of skill.config) {
      const value = inputConfig[field.key];
      const maxLength = field.maxLength ?? 500;

      if (field.type === 'list') {
        if (!Array.isArray(value)) continue;
        const items = value
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim().slice(0, maxLength))
          .filter(Boolean)
          .slice(0, field.maxItems ?? 10);
        if (items.length > 0) config[field.key] = items;
        continue;
      }

      if (typeof value !== 'string') continue;
      const trimmed = value.trim().slice(0, maxLength);
      if (trimmed) config[field.key] = trimmed;
    }

    out[skill.id] = { enabled, config };
  }

  return out;
}
