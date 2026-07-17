import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationConditionService } from './automation-condition.service';
import type { StepExecutionArgs } from '../automation.types';
import type { PrismaService } from '../../prisma/prisma.service';

function baseArgs(
  overrides: Partial<StepExecutionArgs> = {},
): StepExecutionArgs {
  return {
    automation: { id: 'aut-1', accountId: 'acc-1', userId: 'user-1' },
    contactId: 'contact-1',
    context: {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: null,
    triggerEvent: 'new_message_received',
    ...overrides,
  };
}

describe('AutomationConditionService', () => {
  describe('tag_presence', () => {
    it('returns true when a matching contact_tags row exists', async () => {
      const prisma = { contact_tags: { count: vi.fn().mockResolvedValue(1) } };
      const service = new AutomationConditionService(
        prisma as unknown as PrismaService,
      );
      const result = await service.evaluate(
        { subject: 'tag_presence', operand: 'tag-uuid' },
        baseArgs(),
      );
      expect(result).toBe(true);
      expect(prisma.contact_tags.count).toHaveBeenCalledWith({
        where: { contact_id: 'contact-1', tag_id: 'tag-uuid' },
      });
    });

    it('returns false when no matching row exists', async () => {
      const prisma = { contact_tags: { count: vi.fn().mockResolvedValue(0) } };
      const service = new AutomationConditionService(
        prisma as unknown as PrismaService,
      );
      expect(
        await service.evaluate(
          { subject: 'tag_presence', operand: 'tag-uuid' },
          baseArgs(),
        ),
      ).toBe(false);
    });

    it('returns false without a contactId or operand', async () => {
      const prisma = { contact_tags: { count: vi.fn() } };
      const service = new AutomationConditionService(
        prisma as unknown as PrismaService,
      );
      expect(
        await service.evaluate(
          { subject: 'tag_presence' },
          baseArgs({ contactId: null }),
        ),
      ).toBe(false);
      expect(
        await service.evaluate({ subject: 'tag_presence' }, baseArgs()),
      ).toBe(false);
      expect(prisma.contact_tags.count).not.toHaveBeenCalled();
    });
  });

  describe('contact_field', () => {
    it('matches when the selected column equals cfg.value', async () => {
      const prisma = {
        contacts: {
          findFirst: vi.fn().mockResolvedValue({ email: 'a@b.com' }),
        },
      };
      const service = new AutomationConditionService(
        prisma as unknown as PrismaService,
      );
      const result = await service.evaluate(
        { subject: 'contact_field', operand: 'email', value: 'a@b.com' },
        baseArgs(),
      );
      expect(result).toBe(true);
      expect(prisma.contacts.findFirst).toHaveBeenCalledWith({
        where: { id: 'contact-1', account_id: 'acc-1' },
        select: { email: true },
      });
    });

    it('does not match on a different value', async () => {
      const prisma = {
        contacts: {
          findFirst: vi.fn().mockResolvedValue({ email: 'a@b.com' }),
        },
      };
      const service = new AutomationConditionService(
        prisma as unknown as PrismaService,
      );
      expect(
        await service.evaluate(
          { subject: 'contact_field', operand: 'email', value: 'other@b.com' },
          baseArgs(),
        ),
      ).toBe(false);
    });

    it('returns false (not throws) when the operand is an invalid column', async () => {
      const prisma = {
        contacts: {
          findFirst: vi
            .fn()
            .mockRejectedValue(new Error('Unknown field `not_a_real_column`')),
        },
      };
      const service = new AutomationConditionService(
        prisma as unknown as PrismaService,
      );
      expect(
        await service.evaluate(
          {
            subject: 'contact_field',
            operand: 'not_a_real_column',
            value: 'x',
          },
          baseArgs(),
        ),
      ).toBe(false);
    });

    it('returns false without a contactId or operand', async () => {
      const prisma = { contacts: { findFirst: vi.fn() } };
      const service = new AutomationConditionService(
        prisma as unknown as PrismaService,
      );
      expect(
        await service.evaluate(
          { subject: 'contact_field', value: 'x' },
          baseArgs({ contactId: null }),
        ),
      ).toBe(false);
      expect(prisma.contacts.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('message_content', () => {
    it('matches a case-insensitive substring of the triggering message', async () => {
      const service = new AutomationConditionService({} as PrismaService);
      const result = await service.evaluate(
        { subject: 'message_content', value: 'PRICING' },
        baseArgs({ context: { message_text: 'ask about pricing please' } }),
      );
      expect(result).toBe(true);
    });

    it('does not match when the substring is absent', async () => {
      const service = new AutomationConditionService({} as PrismaService);
      const result = await service.evaluate(
        { subject: 'message_content', value: 'refund' },
        baseArgs({ context: { message_text: 'ask about pricing' } }),
      );
      expect(result).toBe(false);
    });
  });

  describe('time_of_day', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('matches within a same-day window', async () => {
      vi.setSystemTime(new Date(2024, 0, 1, 10, 30));
      const service = new AutomationConditionService({} as PrismaService);
      expect(
        await service.evaluate(
          { subject: 'time_of_day', operand: '09:00-18:00' },
          baseArgs(),
        ),
      ).toBe(true);
    });

    it('does not match outside a same-day window', async () => {
      vi.setSystemTime(new Date(2024, 0, 1, 20, 0));
      const service = new AutomationConditionService({} as PrismaService);
      expect(
        await service.evaluate(
          { subject: 'time_of_day', operand: '09:00-18:00' },
          baseArgs(),
        ),
      ).toBe(false);
    });

    it('handles an overnight-wrapping window', async () => {
      const service = new AutomationConditionService({} as PrismaService);
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));
      expect(
        await service.evaluate(
          { subject: 'time_of_day', operand: '18:00-09:00' },
          baseArgs(),
        ),
      ).toBe(true);
      vi.setSystemTime(new Date(2024, 0, 1, 4, 0));
      expect(
        await service.evaluate(
          { subject: 'time_of_day', operand: '18:00-09:00' },
          baseArgs(),
        ),
      ).toBe(true);
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      expect(
        await service.evaluate(
          { subject: 'time_of_day', operand: '18:00-09:00' },
          baseArgs(),
        ),
      ).toBe(false);
    });

    it('returns false for a malformed operand', async () => {
      const service = new AutomationConditionService({} as PrismaService);
      expect(
        await service.evaluate(
          { subject: 'time_of_day', operand: '' },
          baseArgs(),
        ),
      ).toBe(false);
      expect(
        await service.evaluate({ subject: 'time_of_day' }, baseArgs()),
      ).toBe(false);
    });
  });

  it('returns false for an unrecognized subject', async () => {
    const service = new AutomationConditionService({} as PrismaService);
    expect(
      await service.evaluate(
        { subject: 'unknown_subject' as never },
        baseArgs(),
      ),
    ).toBe(false);
  });
});
