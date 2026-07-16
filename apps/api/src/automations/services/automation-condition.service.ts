import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ConditionStepConfig } from '../automation.types';
import type { StepExecutionArgs } from '../automation.types';

/** Ported from apps/web/src/lib/automations/engine.ts's `evaluateCondition()`. */
@Injectable()
export class AutomationConditionService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(
    cfg: ConditionStepConfig,
    args: StepExecutionArgs,
  ): Promise<boolean> {
    switch (cfg.subject) {
      case 'tag_presence': {
        if (!args.contactId || !cfg.operand) return false;
        // contact_tags has no account_id column (its RLS keys off the
        // parent contact), so tenant scoping here relies on the
        // contact-ownership guard in the dispatch service.
        const count = await this.prisma.contact_tags.count({
          where: { contact_id: args.contactId, tag_id: cfg.operand },
        });
        return count > 0;
      }
      case 'contact_field': {
        if (!args.contactId || !cfg.operand) return false;
        // Scope to the account so the condition can't be turned into a
        // cross-tenant read oracle via the bypassrls Prisma connection.
        // `cfg.operand` selects an arbitrary contacts column, matching
        // the original's unrestricted `.select(cfg.operand)` — an
        // invalid/unknown column throws here (Prisma validates select
        // keys), caught below and treated as no-match, mirroring the
        // original silently ignoring the Supabase query's error field.
        try {
          const contact = await this.prisma.contacts.findFirst({
            where: {
              id: args.contactId,
              account_id: args.automation.accountId,
            },
            select: { [cfg.operand]: true } as Record<string, true>,
          });
          const v = (contact as Record<string, unknown> | null)?.[cfg.operand];
          if (v == null) return false;
          return (
            String(v as string | number | boolean) === String(cfg.value ?? '')
          );
        } catch {
          return false;
        }
      }
      case 'message_content': {
        const text = (args.context.message_text ?? '').toString();
        return text.toLowerCase().includes((cfg.value ?? '').toLowerCase());
      }
      case 'time_of_day': {
        // operand form "HH:mm-HH:mm" — true if now is within that window
        // (supports over-midnight ranges like "18:00-09:00").
        const [from, to] = (cfg.operand ?? '').split('-');
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
}
