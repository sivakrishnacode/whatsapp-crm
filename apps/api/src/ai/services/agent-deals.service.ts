import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { memberProfileById } from '../../account/member-lookup.util';

export interface CreateDealInput {
  title: string;
  value?: number;
  pipeline_id: string;
  stage_id: string;
  contact_id?: string | null;
  notes?: string;
}

export interface AssignDealInput {
  deal_id: string;
  assigned_to_user_id: string;
}

@Injectable()
export class AgentDealsService {
  private readonly logger = new Logger(AgentDealsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createDeal(input: CreateDealInput, accountId: string) {
    if (!input.title?.trim()) {
      return { ok: false, detail: 'Deal title is required.' };
    }

    if (!input.pipeline_id) {
      return { ok: false, detail: 'Pipeline ID is required.' };
    }

    if (!input.stage_id) {
      return { ok: false, detail: 'Stage ID is required.' };
    }

    // Verify contact if provided
    let contactId: string | null = null;
    if (input.contact_id) {
      const contact = await this.prisma.contacts.findFirst({
        where: { id: input.contact_id, account_id: accountId },
      });
      if (!contact) {
        return { ok: false, detail: 'Contact not found in this account.' };
      }
      contactId = input.contact_id;
    }

    // Get account owner
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { ownerUserId: true },
    });

    if (!account?.ownerUserId) {
      return { ok: false, detail: 'Cannot assign deal - no owner.' };
    }

    try {
      const deal = await this.prisma.deals.create({
        data: {
          account_id: accountId,
          pipeline_id: input.pipeline_id,
          stage_id: input.stage_id,
          user_id: account.ownerUserId,
          assigned_to: account.ownerUserId,
          contact_id: contactId,
          title: input.title.slice(0, 255),
          value: input.value ?? 0,
          notes: input.notes?.slice(0, 4000) ?? null,
          status: 'open',
        },
      });

      this.logger.log(`Deal created: ${deal.id} for account ${accountId}`);
      return { ok: true, detail: `Deal "${deal.title}" created successfully.` };
    } catch (error) {
      return {
        ok: false,
        detail: `Failed to create deal: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  }

  async assignDeal(input: AssignDealInput, accountId: string) {
    if (!input.deal_id || !input.assigned_to_user_id) {
      return { ok: false, detail: 'Deal ID and user ID are required.' };
    }

    const deal = await this.prisma.deals.findFirst({
      where: { id: input.deal_id, account_id: accountId },
    });

    if (!deal) {
      return { ok: false, detail: 'Deal not found in this account.' };
    }

    // Verify the assignee is a member of THIS workspace. `assigned_to_user_id`
    // is a `profiles.id` (that is what `deals.assigned_to` references), so
    // membership has to be looked up through the person — see the note on
    // profileIsMember.
    const user = await memberProfileById(
      this.prisma,
      accountId,
      input.assigned_to_user_id,
    );

    if (!user) {
      return { ok: false, detail: 'Team member not found in this account.' };
    }

    try {
      await this.prisma.deals.update({
        where: { id: input.deal_id },
        data: { assigned_to: input.assigned_to_user_id },
      });

      this.logger.log(`Deal ${input.deal_id} assigned to ${user.fullName}`);
      return { ok: true, detail: `Deal assigned to ${user.fullName}.` };
    } catch (error) {
      return {
        ok: false,
        detail: `Failed to assign deal: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  }
}
