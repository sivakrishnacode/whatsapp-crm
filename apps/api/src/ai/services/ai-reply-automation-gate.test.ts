import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AiReplyService } from './ai-reply.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AgentRuntimeService } from './agent-runtime.service';
import type { AiCreditsService } from '../credits/ai-credits.service';
import type { ChannelSenderService } from '../../common/messaging/channel-sender.service';
import type { Channel } from '../../common/messaging/channel';

/**
 * ============================================================
 * The automation gate: when may an automation silence the bot?
 *
 * ONLY when it actually answers THIS message on THIS channel.
 *
 * This gate shipped as a bare existence check — active + trigger type,
 * with no channel filter and no keyword filter — and one "web chat"
 * automation scoped to `channels = {web}` with the keyword "hi" turned
 * the AI off across the entire workspace, on WhatsApp and Instagram,
 * for every message, permanently and silently. These cases are the
 * difference between that and a gate that means something.
 * ============================================================
 */

const ACCOUNT_ID = 'acc-1';
const CONVERSATION_ID = 'conv-1';
const CONTACT_ID = 'contact-1';
const OWNER_USER_ID = 'user-1';

const CONFIG = {
  provider: 'gemini',
  model: 'gemini-3.5-flash',
  source: 'byok' as const,
  creditBalance: 0,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  testMode: false,
  testNumbers: [] as string[],
  profile: { greetingMessage: '' },
  escalation: {
    handoffEnabled: false,
    handoffTriggerPhrases: [] as string[],
    handoffMessage: '',
    fallbackMessage: '',
  },
};

// These factories are hoisted above the consts below, so each one must
// read them lazily — `mockResolvedValue(CONFIG)` evaluates CONFIG while
// it is still in the temporal dead zone and the whole file fails to load.
vi.mock('../lib/config', () => ({
  loadAiConfig: vi.fn(() => Promise.resolve(CONFIG)),
}));

vi.mock('../lib/context', () => ({
  buildConversationContext: vi.fn(() =>
    Promise.resolve([
      { role: 'user', content: 'Hi there, do you deliver to Chennai?' },
    ]),
  ),
}));

vi.mock('../lib/generate', () => ({
  generateReply: vi.fn(() =>
    Promise.resolve({
      text: 'Yes, we deliver to Chennai.',
      handoff: false,
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  ),
}));

interface AutomationRow {
  triggerType: string;
  triggerConfig: unknown;
  channels: string[];
}

function build(opts: { automations: AutomationRow[]; channel: Channel }) {
  const findAutomations = vi.fn().mockResolvedValue(opts.automations);

  const prisma = {
    automation: { findMany: findAutomations },
    conversations: {
      findUnique: vi.fn().mockResolvedValue({
        assigned_agent_id: null,
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    contacts: {
      findUnique: vi.fn().mockResolvedValue({ phone: '+919876543210' }),
    },
    // claim_ai_reply_slot — always granted; the cap is not what is under test.
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ claim_ai_reply_slot: true }]),
  } as unknown as PrismaService;

  const runtime = {
    assemble: vi.fn().mockResolvedValue({
      systemPrompt: 'you are a bot',
      tools: [],
      executeTool: vi.fn(),
    }),
  } as unknown as AgentRuntimeService;

  const credits = {
    chargeGeneration: vi.fn().mockResolvedValue(undefined),
  } as unknown as AiCreditsService;

  const sendText = vi.fn().mockResolvedValue({ messageId: 'wamid.1' });
  const channelSender = {
    channelOf: vi.fn().mockResolvedValue(opts.channel),
    sendText,
  } as unknown as ChannelSenderService;

  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };

  const service = new AiReplyService(
    prisma,
    runtime,
    credits,
    channelSender,
    queue as never,
  );

  return { service, sendText, findAutomations };
}

const run = (service: AiReplyService) =>
  service.runInboundAiReply({
    accountId: ACCOUNT_ID,
    conversationId: CONVERSATION_ID,
    contactId: CONTACT_ID,
    configOwnerUserId: OWNER_USER_ID,
  });

describe('ai auto-reply — the automation gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replies when the only automation is scoped to another channel', async () => {
    // The bug, exactly: a web-only keyword automation, a WhatsApp message.
    const { service, sendText } = build({
      channel: 'whatsapp',
      automations: [
        {
          triggerType: 'keyword_match',
          triggerConfig: { keywords: ['hi'], match_type: 'contains' },
          channels: ['web'],
        },
      ],
    });

    await run(service);

    expect(sendText).toHaveBeenCalledOnce();
  });

  it('replies when a same-channel keyword automation does not match the text', async () => {
    const { service, sendText } = build({
      channel: 'whatsapp',
      automations: [
        {
          triggerType: 'keyword_match',
          triggerConfig: { keywords: ['refund'], match_type: 'contains' },
          channels: [],
        },
      ],
    });

    await run(service);

    expect(sendText).toHaveBeenCalledOnce();
  });

  it('stays silent when a same-channel keyword automation does match', async () => {
    const { service, sendText } = build({
      channel: 'whatsapp',
      automations: [
        {
          triggerType: 'keyword_match',
          triggerConfig: { keywords: ['deliver'], match_type: 'contains' },
          channels: ['whatsapp'],
        },
      ],
    });

    await run(service);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('stays silent for an unscoped new_message_received automation', async () => {
    // No keywords to match on — it answers every message, so it owns this one.
    const { service, sendText } = build({
      channel: 'whatsapp',
      automations: [
        {
          triggerType: 'new_message_received',
          triggerConfig: {},
          channels: [],
        },
      ],
    });

    await run(service);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('replies when the workspace has no message-answering automation', async () => {
    const { service, sendText } = build({
      channel: 'whatsapp',
      automations: [],
    });

    await run(service);

    expect(sendText).toHaveBeenCalledOnce();
  });

  it('defers to automations — fails closed — when the check itself throws', async () => {
    const { service, sendText, findAutomations } = build({
      channel: 'whatsapp',
      automations: [
        {
          triggerType: 'new_message_received',
          triggerConfig: {},
          channels: [],
        },
      ],
    });
    findAutomations.mockRejectedValueOnce(new Error('connection reset'));

    await run(service);

    // One reply from a possible automation beats two replies to one message.
    expect(sendText).not.toHaveBeenCalled();
  });
});
