import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import { toE164 } from '../../common/phone/phone.util';
import { resolveAccountCountry } from '../../common/phone/account-country.util';

/**
 * Turns one Facebook Lead Ads notification into a contact, a deal, a
 * conversation and a first message.
 *
 * Moved out of `FacebookLeadsWebhookController` when lead processing
 * moved onto a queue. Meta wants a 200 from a webhook within seconds
 * and retries when it does not get one, so this work could never
 * happen inline — but the `void this.processLead(...).catch(log)` that
 * kept the handler fast also meant a failed Graph call lost the lead
 * outright, with nothing anywhere recording that one had arrived.
 *
 * The webhook now acknowledges immediately and this runs on the
 * lead-fetch queue, where a Graph blip is a retry rather than a lost
 * customer.
 */
@Injectable()
export class FacebookLeadService {
  private readonly logger = new Logger(FacebookLeadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliver: WebhookDeliverService,
  ) {}

  async processLead(leadgenId: string, pageId: string): Promise<void> {
    const page = await this.prisma.facebook_pages.findFirst({
      where: { page_id: pageId },
      select: { user_id: true, page_access_token: true, is_syncing: true },
    });

    if (!page?.is_syncing) return;

    // Resolve tenant account_id
    const profile = await this.prisma.profile.findFirst({
      where: { userId: page.user_id },
      select: { accountId: true },
    });

    if (!profile) {
      this.logger.warn(
        `No Profile/Account found for Facebook Page user: ${page.user_id}`,
      );
      return;
    }

    const accountId = profile.accountId;

    let name = '';
    let email = '';
    let phone = '';
    let company = '';

    const isMock = pageId.startsWith('page_mock');
    if (isMock) {
      name = 'Test Lead Ads User';
      email = 'test.lead@example.com';
      phone = '+919999988888';
      company = 'Meta Sandbox LLC';
    } else {
      const leadRes = await fetch(
        `https://graph.facebook.com/v20.0/${leadgenId}?access_token=${page.page_access_token}`,
      );
      const leadData = (await leadRes.json()) as {
        field_data?: Array<{ name: string; values?: string[] }>;
        error?: unknown;
      };

      if (!leadRes.ok || leadData.error) {
        this.logger.error(
          `Meta Graph API error for lead ${leadgenId}`,
          leadData.error,
        );
        return;
      }

      for (const field of leadData.field_data ?? []) {
        const val = field.values?.[0] ?? '';
        if (field.name === 'full_name' || field.name === 'name') name = val;
        else if (field.name === 'email') email = val;
        else if (field.name === 'phone_number' || field.name === 'phone')
          phone = val;
        else if (field.name === 'company' || field.name === 'company_name')
          company = val;
      }
    }

    // Lead-gen forms let the advertiser choose which fields to ask
    // for, so a lead can arrive with no phone at all. The previous
    // `phone || '+0000000000'` placeholder minted a contact nobody can
    // ever be messaged on, one per phone-less lead, all colliding on
    // the same number. There is no salvaging that: `contacts` requires
    // a phone, an IGSID, or a web visitor id (contacts_identity_chk)
    // and a lead has none of the other two.
    const canonicalPhone = toE164(
      phone,
      await resolveAccountCountry(this.prisma, accountId),
    );
    if (!canonicalPhone) {
      this.logger.warn(
        `Facebook lead ${leadgenId} has no usable phone number — skipping. ` +
          'Add a phone field to the lead form to capture these.',
      );
      return;
    }

    // Upsert contact
    let contact = await this.prisma.contacts.findFirst({
      where: { account_id: accountId, phone: canonicalPhone },
    });

    if (!contact) {
      contact = await this.prisma.contacts.create({
        data: {
          account_id: accountId,
          user_id: page.user_id,
          phone: canonicalPhone,
          name: name || 'Facebook Lead',
          email: email || null,
          company: company || null,
          source: 'facebook_lead',
        },
      });
      this.logger.log(
        `Created contact ${contact.id} from FB lead ${leadgenId}`,
      );

      await this.webhookDeliver.dispatchWebhookEvent(
        accountId,
        'contact.created',
        {
          contact_id: contact.id,
          phone: canonicalPhone,
          name: contact.name,
        },
      );
    } else {
      const updates: Record<string, unknown> = {};
      if (!contact.name && name) updates.name = name;
      if (!contact.email && email) updates.email = email;
      if (Object.keys(updates).length > 0) {
        await this.prisma.contacts.update({
          where: { id: contact.id },
          data: updates,
        });
      }
    }

    // Create pipeline deal in first stage of first pipeline
    const pipeline = await this.prisma.pipelines.findFirst({
      where: { account_id: accountId },
      select: { id: true },
    });

    if (pipeline) {
      const stage = await this.prisma.pipeline_stages.findFirst({
        where: { pipeline_id: pipeline.id },
        orderBy: { position: 'asc' },
        select: { id: true },
      });

      if (stage) {
        await this.prisma.deals.create({
          data: {
            account_id: accountId,
            user_id: page.user_id,
            pipeline_id: pipeline.id,
            stage_id: stage.id,
            contact_id: contact.id,
            title: `${contact.name || 'Facebook Lead'} - Lead Ads`,
            value: 0,
            currency: 'INR',
            status: 'active',
          },
        });
        this.logger.log(`Created pipeline deal for contact ${contact.id}`);
      }
    }

    // Create conversation + message
    const lastMessage = `New Facebook Lead: ${contact.name}`;

    // A lead-gen lead is followed up on WhatsApp (the contact is created
    // from the form's phone field), so this is the WhatsApp thread —
    // pinned explicitly now that a contact can own one per channel.
    let conversation = await this.prisma.conversations.findFirst({
      where: {
        account_id: accountId,
        contact_id: contact.id,
        channel: 'whatsapp',
      },
    });

    if (!conversation) {
      conversation = await this.prisma.conversations.create({
        data: {
          account_id: accountId,
          user_id: page.user_id,
          contact_id: contact.id,
          channel: 'whatsapp',
          status: 'open',
          last_message_text: lastMessage,
          last_message_at: new Date(),
          unread_count: 1,
        },
      });
    } else {
      await this.prisma.conversations.update({
        where: { id: conversation.id },
        data: {
          last_message_text: lastMessage,
          last_message_at: new Date(),
          unread_count: { increment: 1 },
          status: 'open',
        },
      });
    }

    await this.prisma.messages.create({
      data: {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: `[Facebook Lead Capture] Email: ${email || 'N/A'}, Phone: ${phone || 'N/A'}, Company: ${company || 'N/A'}`,
        status: 'delivered',
      },
    });
  }
}
