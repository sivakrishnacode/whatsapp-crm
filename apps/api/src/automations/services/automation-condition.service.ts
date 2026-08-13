import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SegmentMembershipService } from '../../common/segments/segment-membership.service';
import type {
  ConditionOperator,
  ConditionRule,
  ConditionStepConfig,
  StepExecutionArgs,
} from '../automation.types';
import { toChannel } from '../../common/messaging/channel';
import { interpolate, resolveToken } from './automation-interpolation.util';

/**
 * Decides which branch a `condition` step takes.
 *
 * ONE RULE BECAME MANY
 *   The original evaluated a single `{subject, operand, value}` triple.
 *   Real rules are rarely that simple ("VIP tag AND the message mentions
 *   refund"), and the workaround — nesting a condition inside a
 *   condition's branch — produced trees nobody could read.
 *
 *   `rules[]` + `match: all|any` replaces that. The legacy triple is
 *   lifted into a one-rule list when `rules` is absent, so every
 *   automation written before this evaluates EXACTLY as it did. That
 *   fallback is not decoration: these rows are live, and a condition
 *   silently flipping branch is a customer getting the wrong message.
 *
 * A RULE THAT CANNOT BE ANSWERED IS FALSE
 *   Not an exception, and not "skip the rule". Under `any` a skipped rule
 *   would be invisible; under `all` an exception would kill a run over a
 *   deleted tag. False is the answer that degrades predictably, and the
 *   branch the author wrote for "no" is a branch they thought about.
 */
@Injectable()
export class AutomationConditionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentMembershipService,
  ) {}

  async evaluate(
    cfg: ConditionStepConfig,
    args: StepExecutionArgs,
  ): Promise<boolean> {
    const rules = normalizeRules(cfg);
    if (rules.length === 0) return false;

    const matchAny = cfg.match === 'any';
    for (const rule of rules) {
      const result = await this.evaluateRule(rule, args);
      if (matchAny && result) return true;
      if (!matchAny && !result) return false;
    }
    // Fell through: under `any` nothing matched, under `all` everything did.
    return !matchAny;
  }

  private async evaluateRule(
    rule: ConditionRule,
    args: StepExecutionArgs,
  ): Promise<boolean> {
    switch (rule.subject) {
      case 'tag_presence': {
        if (!args.contactId || !rule.operand) return false;
        // contact_tags has no account_id column (its RLS keys off the
        // parent contact), so tenant scoping here relies on the
        // contact-ownership guard in the dispatch service.
        const count = await this.prisma.contact_tags.count({
          where: { contact_id: args.contactId, tag_id: rule.operand },
        });
        const present = count > 0;
        // `is_empty` reads as "does not have the tag" for a presence
        // check — the only negation that makes sense here.
        return rule.operator === 'is_empty' || rule.operator === 'not_equals'
          ? !present
          : present;
      }

      case 'contact_field': {
        if (!args.contactId || !rule.operand) return false;
        const actual = await this.contactFieldValue(rule.operand, args);
        if (actual === undefined) return false;
        return compare(actual, rule, args);
      }

      case 'message_content': {
        const text = String(args.context.message_text ?? '');
        // Default operator stays `contains` — that is what the original
        // did unconditionally, and most rules mean it.
        return compare(text, { ...rule, operator: rule.operator ?? 'contains' }, args);
      }

      case 'channel': {
        // An absent context channel is WhatsApp — the WhatsApp webhook
        // predates the field, so `undefined` and `'whatsapp'` are the
        // same event and must compare equal.
        const actual = toChannel(args.context.channel);
        const expected = (rule.value ?? rule.operand ?? '').trim().toLowerCase();
        if (!expected) return false;
        return rule.operator === 'not_equals'
          ? actual !== expected
          : actual === expected;
      }

      case 'expression': {
        // The rule that can read anything the run has produced —
        // variables, an earlier step's response, a status code.
        const actual = resolveToken(String(rule.operand ?? ''), args.context);
        return compare(actual, rule, args);
      }

      case 'segment_membership': {
        if (!args.contactId || !rule.operand) return false;
        // findForAccount pins the segment to this automation's workspace;
        // without it a config blob could name another tenant's segment
        // and turn this into a cross-tenant membership oracle.
        const segment = await this.segments.findForAccount(
          args.automation.accountId,
          rule.operand,
        );
        if (!segment) return false;
        // resolve() is the ONLY correct way to turn a segment into
        // people: reading contact_segment_members directly returns
        // nothing for a dynamic segment, which reads as "not a member"
        // rather than as the bug it is.
        const ids = await this.segments.resolve(
          args.automation.accountId,
          segment.id,
        );
        const member = ids.includes(args.contactId);
        return rule.operator === 'is_empty' || rule.operator === 'not_equals'
          ? !member
          : member;
      }

      case 'day_of_week': {
        // operand is a comma list of short day names: "mon,tue,wed".
        const allowed = String(rule.operand ?? '')
          .split(',')
          .map((d) => d.trim().toLowerCase().slice(0, 3))
          .filter(Boolean);
        if (allowed.length === 0) return false;
        const today = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][
          new Date().getDay()
        ];
        return allowed.includes(today);
      }

      case 'time_of_day': {
        // operand form "HH:mm-HH:mm" — true if now is within that window
        // (supports over-midnight ranges like "18:00-09:00").
        const [from, to] = String(rule.operand ?? '').split('-');
        if (!from || !to) return false;
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        const parse = (s: string) => {
          const [h, m] = s.split(':').map(Number);
          return (h || 0) * 60 + (m || 0);
        };
        const f = parse(from);
        const t = parse(to);
        return f <= t ? mins >= f && mins < t : mins >= f || mins < t;
      }

      default:
        return false;
    }
  }

  /**
   * Read one contact column.
   *
   * Scoped to the account so the condition can't be turned into a
   * cross-tenant read oracle via the bypassrls Prisma connection. An
   * unknown column throws inside Prisma's select validation, which we
   * catch and report as "no value" — mirroring the original's silent
   * treatment of a bad column name.
   *
   * `custom:<id>` reads a custom field instead, matching how
   * `update_contact_field` addresses them — an author who can WRITE a
   * custom field expects to be able to branch on it.
   */
  private async contactFieldValue(
    field: string,
    args: StepExecutionArgs,
  ): Promise<unknown> {
    if (field.startsWith('custom:')) {
      const customFieldId = field.slice('custom:'.length);
      if (!customFieldId) return undefined;
      const row = await this.prisma.contact_custom_values.findFirst({
        where: {
          contact_id: args.contactId!,
          custom_field_id: customFieldId,
          // Pin the field definition to this account, not just the value.
          custom_fields: { account_id: args.automation.accountId },
        },
        select: { value: true },
      });
      return row?.value ?? '';
    }

    try {
      const contact = await this.prisma.contacts.findFirst({
        where: {
          id: args.contactId!,
          account_id: args.automation.accountId,
        },
        select: { [field]: true } as Record<string, true>,
      });
      const v = (contact as Record<string, unknown> | null)?.[field];
      return v ?? '';
    } catch {
      return undefined;
    }
  }
}

/**
 * The rules to evaluate, whichever shape the config is in.
 *
 * Exported for the tests that pin the legacy lift — it is the part most
 * likely to be "simplified" by someone who has not seen the old rows.
 */
export function normalizeRules(cfg: ConditionStepConfig): ConditionRule[] {
  if (Array.isArray(cfg.rules) && cfg.rules.length > 0) {
    return cfg.rules.filter((r) => r && r.subject);
  }
  if (cfg.subject) {
    return [
      { subject: cfg.subject, operand: cfg.operand, value: cfg.value },
    ];
  }
  return [];
}

/**
 * Apply one operator.
 *
 * The comparison value is interpolated, so a rule can compare a contact
 * field against an earlier step's output rather than only a literal.
 */
function compare(
  actual: unknown,
  rule: ConditionRule,
  args: StepExecutionArgs,
): boolean {
  const operator: ConditionOperator = rule.operator ?? 'equals';
  const expected = interpolate(String(rule.value ?? ''), args.context);
  const actualText = toText(actual);

  switch (operator) {
    case 'equals':
      return actualText === expected;
    case 'not_equals':
      return actualText !== expected;
    case 'contains':
      return actualText.toLowerCase().includes(expected.toLowerCase());
    case 'not_contains':
      return !actualText.toLowerCase().includes(expected.toLowerCase());
    case 'starts_with':
      return actualText.toLowerCase().startsWith(expected.toLowerCase());
    case 'ends_with':
      return actualText.toLowerCase().endsWith(expected.toLowerCase());
    case 'is_empty':
      return actualText.trim() === '';
    case 'is_not_empty':
      return actualText.trim() !== '';
    case 'greater_than':
    case 'less_than': {
      const a = Number(actualText);
      const b = Number(expected);
      // Not comparable is FALSE, never an error: "is the order total over
      // 500" against a missing total is simply not true.
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return operator === 'greater_than' ? a > b : a < b;
    }
    case 'matches_regex':
      try {
        // No 'g' flag: a stateful lastIndex across calls would make the
        // same rule alternate true/false on identical input.
        return new RegExp(expected).test(actualText);
      } catch {
        // An invalid pattern is an authoring mistake, not a run failure.
        return false;
      }
    default:
      return false;
  }
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
