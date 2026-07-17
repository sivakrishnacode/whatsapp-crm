import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalDispatchGuard } from '../automations/guards/internal-dispatch.guard';
import { FlowDispatchService } from './services/flow-dispatch.service';
import { InternalFlowDispatchDto } from './dto/internal-flow-dispatch.dto';
import type { DispatchInboundResult, ParsedInbound } from './flow.types';

/**
 * Internal, machine-to-machine bridge — called by apps/web's WhatsApp
 * webhook route instead of the in-process `dispatchInboundToFlows`
 * call it made before the engine moved here. Reuses the automations
 * bridge's InternalDispatchGuard + INTERNAL_API_SECRET (per the
 * migration plan: don't mint a second secret).
 *
 * Unlike the automations bridge (fire-and-forget, 202), this one is
 * **awaited** by the webhook: the `consumed` flag decides whether the
 * content-level automation triggers and the AI auto-reply also fire
 * for this inbound. So it returns the full DispatchInboundResult with
 * a 200.
 */
@Controller()
export class FlowsEngineController {
  constructor(private readonly dispatch: FlowDispatchService) {}

  @Post('internal/flows/dispatch')
  @UseGuards(InternalDispatchGuard)
  @HttpCode(200)
  async internalDispatch(
    @Body() body: InternalFlowDispatchDto,
  ): Promise<DispatchInboundResult> {
    const message = this.parseMessage(body.message);
    if (!message) {
      // Malformed message payload — treat as not-for-flows rather than
      // erroring the webhook (which would suppress automations too).
      return { consumed: false, outcome: 'no_match' };
    }
    return this.dispatch.dispatchInbound({
      accountId: body.account_id,
      userId: body.user_id,
      contactId: body.contact_id,
      conversationId: body.conversation_id,
      message,
      isFirstInboundMessage: body.is_first_inbound_message,
    });
  }

  private parseMessage(raw: Record<string, unknown>): ParsedInbound | null {
    if (
      raw.kind === 'text' &&
      typeof raw.text === 'string' &&
      typeof raw.meta_message_id === 'string'
    ) {
      return {
        kind: 'text',
        text: raw.text,
        meta_message_id: raw.meta_message_id,
      };
    }
    if (
      raw.kind === 'interactive_reply' &&
      typeof raw.reply_id === 'string' &&
      typeof raw.meta_message_id === 'string'
    ) {
      return {
        kind: 'interactive_reply',
        reply_id: raw.reply_id,
        reply_title: typeof raw.reply_title === 'string' ? raw.reply_title : '',
        meta_message_id: raw.meta_message_id,
      };
    }
    return null;
  }
}
