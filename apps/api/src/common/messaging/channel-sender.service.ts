import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FlowMetaSendService } from '../../whatsapp/flow-meta-send.service';
import { InstagramSendService } from '../../instagram/services/instagram-send.service';
import { WebSendService } from '../../web/services/web-send.service';
import { capabilitiesFor, toChannel, type Channel } from './channel';
import type {
  InteractiveButton,
  InteractiveListSection,
  MediaKind,
} from '../../whatsapp/meta-api.util';

/**
 * Raised when a caller asks for something the target channel cannot do
 * — a list message on Instagram, a template anywhere but WhatsApp.
 *
 * A distinct class because engines want to *skip* an unsupported step
 * and carry on, not abort the run. Message text is written for a human
 * reading an automation log.
 */
export class UnsupportedOnChannelError extends Error {
  constructor(
    readonly channel: Channel,
    readonly capability: string,
    message?: string,
  ) {
    super(
      message ??
        `${capability} is not supported on ${channel}. This step was skipped.`,
    );
    this.name = 'UnsupportedOnChannelError';
  }
}

/**
 * Raised when a step wants to message a contact who has no thread to
 * message them on.
 *
 * WHY IT IS ITS OWN CLASS, ALONGSIDE UnsupportedOnChannelError
 *   The two are different questions — "this channel cannot do that" versus
 *   "there is nowhere to send it" — but they want the identical answer from
 *   an engine: skip this step, mark the run partial, keep going.
 *
 *   The case that made this necessary is a hosted form submission. It
 *   creates or matches a contact but has no conversation at all: the person
 *   filled in a web page, they were never in a chat. Every non-messaging
 *   step of a `form_submitted` automation (add a tag, create a deal, fire a
 *   webhook) is perfectly runnable; only the sends are not. Treating that
 *   as a failure would mark the whole run failed and bury the steps that
 *   did work.
 */
export class NoReachableConversationError extends Error {
  constructor(
    readonly contactId: string | null,
    message?: string,
  ) {
    super(
      message ??
        'This contact has no conversation to message, so the step was skipped.',
    );
    this.name = 'NoReachableConversationError';
  }
}

export interface ChannelSendResult {
  /** The platform's own message id — a WhatsApp wamid or an Instagram mid. */
  messageId: string;
}

interface BaseArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
}

/**
 * Attribution for a reply an AI agent wrote (migration 084).
 *
 * Written at INSERT time by each channel's own persist step rather than
 * patched on afterwards: the row is the only record that this agent
 * answered, and a follow-up UPDATE would have to guess which of the
 * bot messages on the thread it had just created.
 */
interface AiAttribution {
  aiAgentId?: string | null;
}

/**
 * Routes an outbound message to whichever platform its conversation
 * lives on.
 *
 * WHY THIS EXISTS
 *   Before Instagram, the AI reply service, the flow runner and the
 *   automation step executor all called FlowMetaSendService directly —
 *   i.e. all three were hard-wired to the WhatsApp Cloud API. Teaching
 *   each of them about a second channel would have meant three parallel
 *   branches that then drift apart.
 *
 *   Instead they call this, it reads `conversations.channel`, and it
 *   delegates. An automation fired by an Instagram DM replies on
 *   Instagram with no change to the automation engine at all.
 *
 *   Web proved the seam works: adding it was a branch per method here
 *   and nothing whatsoever in the three engines. AI auto-reply, every
 *   automation and every flow started working on the web widget without
 *   being told the channel exists.
 *
 * CAPABILITY GAPS ARE EXPLICIT, NOT SILENT
 *   Instagram has no list messages and no templates; web has no
 *   templates either. Rather than quietly downgrading (which produces a
 *   message the flow author did not write) or crashing, unsupported
 *   combinations throw UnsupportedOnChannelError and the caller decides.
 *   The one exception is buttons, where Instagram's quick replies are a
 *   genuine equivalent rather than a downgrade.
 *
 * WEB IS CHECKED FIRST IN EVERY METHOD
 *   Not for precedence — the branches are mutually exclusive — but
 *   because the WhatsApp path is the fall-through `else`. A new channel
 *   that forgets its branch silently becomes WhatsApp and throws deep
 *   inside a Meta call, so every non-WhatsApp channel needs an explicit
 *   one. Worth remembering when Phone lands.
 */
@Injectable()
export class ChannelSenderService {
  private readonly logger = new Logger(ChannelSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => FlowMetaSendService))
    private readonly whatsapp: FlowMetaSendService,
    @Inject(forwardRef(() => InstagramSendService))
    private readonly instagram: InstagramSendService,
    @Inject(forwardRef(() => WebSendService))
    private readonly web: WebSendService,
  ) {}

  /**
   * Which platform a conversation lives on.
   *
   * Account-scoped: `conversationId` reaches these methods from flow
   * configs and request bodies, and Prisma bypasses RLS — an unscoped
   * read would let one tenant's run address another tenant's thread.
   */
  async channelOf(accountId: string, conversationId: string): Promise<Channel> {
    const conversation = await this.prisma.conversations.findFirst({
      where: { id: conversationId, account_id: accountId },
      select: { channel: true },
    });
    if (!conversation) {
      throw new Error(
        `Conversation ${conversationId} not found for this account.`,
      );
    }
    return toChannel(conversation.channel);
  }

  async sendText(
    args: BaseArgs & AiAttribution & { text: string },
  ): Promise<ChannelSendResult> {
    const channel = await this.channelOf(args.accountId, args.conversationId);

    if (channel === 'web') {
      const result = await this.web.sendText({
        accountId: args.accountId,
        conversationId: args.conversationId,
        text: args.text,
        aiAgentId: args.aiAgentId,
      });
      return { messageId: result.messageId };
    }

    if (channel === 'instagram') {
      const result = await this.instagram.sendText({
        accountId: args.accountId,
        conversationId: args.conversationId,
        text: args.text,
        aiAgentId: args.aiAgentId,
      });
      return { messageId: result.messageId };
    }

    const { whatsapp_message_id } = await this.whatsapp.sendText({
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: args.text,
      aiAgentId: args.aiAgentId,
    });
    return { messageId: whatsapp_message_id };
  }

  async sendMedia(
    args: BaseArgs & {
      kind: MediaKind;
      link: string;
      caption?: string;
      filename?: string;
    },
  ): Promise<ChannelSendResult> {
    const channel = await this.channelOf(args.accountId, args.conversationId);

    if (channel === 'web') {
      const result = await this.web.sendMedia({
        accountId: args.accountId,
        conversationId: args.conversationId,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
      });
      return { messageId: result.messageId };
    }

    if (channel === 'instagram') {
      const result = await this.instagram.sendMedia({
        accountId: args.accountId,
        conversationId: args.conversationId,
        // WhatsApp calls it 'document', Instagram calls it 'file'.
        mediaType: args.kind === 'document' ? 'file' : args.kind,
        mediaUrl: args.link,
        caption: args.caption,
      });
      return { messageId: result.messageId };
    }

    const { whatsapp_message_id } = await this.whatsapp.sendMedia({
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    });
    return { messageId: whatsapp_message_id };
  }

  /**
   * Reply buttons.
   *
   * The one capability where the two platforms genuinely converge:
   * WhatsApp interactive buttons and Instagram quick replies present
   * the same affordance and both echo a developer-defined payload back
   * on tap, which is all the flow engine needs to route the answer.
   *
   * Instagram caps quick replies at 13 against WhatsApp's 3, so
   * anything valid for WhatsApp is valid here.
   */
  async sendButtons(
    args: BaseArgs & {
      bodyText: string;
      buttons: InteractiveButton[];
      headerText?: string;
      footerText?: string;
    },
  ): Promise<ChannelSendResult> {
    const channel = await this.channelOf(args.accountId, args.conversationId);

    if (channel === 'web') {
      const result = await this.web.sendButtons({
        accountId: args.accountId,
        conversationId: args.conversationId,
        bodyText: args.bodyText,
        buttons: args.buttons.map((b) => ({ id: b.id, title: b.title })),
        headerText: args.headerText,
        footerText: args.footerText,
      });
      return { messageId: result.messageId };
    }

    if (channel === 'instagram') {
      // Instagram quick replies have no header/footer. Folding them
      // into the body preserves the author's intent rather than
      // silently dropping copy they wrote.
      const text = [args.headerText, args.bodyText, args.footerText]
        .filter(Boolean)
        .join('\n\n');

      const result = await this.instagram.sendButtons({
        accountId: args.accountId,
        conversationId: args.conversationId,
        text,
        buttons: args.buttons.map((b) => ({ id: b.id, title: b.title })),
      });
      return { messageId: result.messageId };
    }

    const { whatsapp_message_id } = await this.whatsapp.sendInteractiveButtons({
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      bodyText: args.bodyText,
      buttons: args.buttons,
      headerText: args.headerText,
      footerText: args.footerText,
    });
    return { messageId: whatsapp_message_id };
  }

  /**
   * Single-select list. WhatsApp only.
   *
   * Deliberately NOT downgraded to Instagram quick replies: a list
   * exists precisely because there are more options than buttons allow
   * (and it carries per-row descriptions and section headings that
   * quick replies cannot represent). Silently flattening one would
   * produce a message the flow author never wrote and, past 13 rows,
   * would drop options the customer needs.
   */
  async sendList(
    args: BaseArgs & {
      bodyText: string;
      buttonLabel: string;
      sections: InteractiveListSection[];
      headerText?: string;
      footerText?: string;
    },
  ): Promise<ChannelSendResult> {
    const channel = await this.channelOf(args.accountId, args.conversationId);

    if (!capabilitiesFor(channel).lists) {
      throw new UnsupportedOnChannelError(
        channel,
        'List messages',
        'Instagram has no list-message type. Use a buttons step instead — ' +
          'Instagram supports up to 13 quick replies.',
      );
    }

    if (channel === 'web') {
      const result = await this.web.sendList({
        accountId: args.accountId,
        conversationId: args.conversationId,
        bodyText: args.bodyText,
        buttonLabel: args.buttonLabel,
        // Meta's row shape uses `id`; ours is structurally the same, so
        // this is a rename rather than a conversion. Kept explicit so a
        // future divergence in either shape shows up here as a type error.
        sections: args.sections.map((section) => ({
          title: section.title,
          rows: section.rows.map((row) => ({
            id: row.id,
            title: row.title,
            description: row.description,
          })),
        })),
        headerText: args.headerText,
        footerText: args.footerText,
      });
      return { messageId: result.messageId };
    }

    const { whatsapp_message_id } = await this.whatsapp.sendInteractiveList({
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      bodyText: args.bodyText,
      buttonLabel: args.buttonLabel,
      sections: args.sections,
      headerText: args.headerText,
      footerText: args.footerText,
    });
    return { messageId: whatsapp_message_id };
  }

  /**
   * Guard for steps that only make sense on one platform, so callers
   * can check before doing expensive setup work.
   */
  async assertSupported(
    accountId: string,
    conversationId: string,
    capability: 'templates' | 'lists' | 'catalog' | 'broadcasts',
  ): Promise<void> {
    const channel = await this.channelOf(accountId, conversationId);
    if (!capabilitiesFor(channel)[capability]) {
      throw new UnsupportedOnChannelError(channel, capability);
    }
  }
}
