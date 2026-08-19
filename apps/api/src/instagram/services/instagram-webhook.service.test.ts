import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InstagramWebhookService } from './instagram-webhook.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { InstagramIdentityService } from './instagram-identity.service';
import type { InstagramMediaMirrorService } from './instagram-media-mirror.service';
import type { InstagramCommentsService } from './instagram-comments.service';
import type { CommentFunnelService } from './comment-funnel.service';
import type { WebhookDeliverService } from '../../v1/services/webhook-deliver.service';
import type { FlowDispatchService } from '../../flows/services/flow-dispatch.service';
import type { AutomationDispatchService } from '../../automations/services/automation-dispatch.service';
import type { AiReplyService } from '../../ai/services/ai-reply.service';
import { encrypt } from '../../common/security/encryption.util';
import type { HumanTakeoverService } from '../../common/conversations/human-takeover.service';

const IG_USER_ID = '17841445515874274';
const IG_APP_SCOPED_ID = '28011694518467843';
const CUSTOMER_IGSID = '9876543210';
const ACCOUNT_ID = 'acc-1';
const OWNER_USER_ID = 'user-1';
const CONVERSATION_ID = 'conv-1';
const CONTACT_ID = 'contact-1';

// The service decrypts the stored token, so the test needs a real key.
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

function makePrismaMock() {
  return {
    instagram_config: {
      findFirst: vi.fn().mockResolvedValue({
        account_id: ACCOUNT_ID,
        user_id: OWNER_USER_ID,
        ig_user_id: IG_USER_ID,
        ig_app_scoped_id: IG_APP_SCOPED_ID,
        access_token: encrypt('test-token'),
      }),
    },
    contacts: {
      findFirst: vi.fn().mockResolvedValue({ id: CONTACT_ID }),
    },
    conversations: {
      findFirst: vi.fn().mockResolvedValue({ id: CONVERSATION_ID }),
      update: vi.fn().mockResolvedValue({}),
    },
    messages: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'msg-row-1' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    message_reactions: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrismaMock>) {
  const identity = {
    findOrCreateContact: vi.fn().mockResolvedValue({
      contact: { id: CONTACT_ID, name: 'Siva', ig_username: 'siva19' },
      wasCreated: false,
    }),
    findOrCreateConversation: vi.fn().mockResolvedValue({
      conversation: { id: CONVERSATION_ID, unread_count: 0 },
      created: false,
    }),
    // Identity-resolved by default: the real one returns the contact
    // unchanged unless its name is still the bare IGSID.
    upgradePlaceholderName: vi
      .fn()
      .mockImplementation(({ contact }: { contact: unknown }) =>
        Promise.resolve(contact),
      ),
  };
  const mediaMirror = { mirror: vi.fn().mockResolvedValue(null) };
  const comments = {
    ingestWebhookComment: vi.fn().mockResolvedValue(undefined),
  };
  // Claims nothing by default, so every existing expectation about
  // flows/automations/AI still describes what happens to an ordinary
  // inbound.
  const commentFunnel = { onPostback: vi.fn().mockResolvedValue(false) };
  const webhookDeliver = {
    dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
  };
  const flowDispatch = {
    dispatchInbound: vi.fn().mockResolvedValue({ consumed: false }),
  };
  const automationDispatch = { dispatch: vi.fn().mockResolvedValue(undefined) };
  const aiReply = {
    dispatchInboundToAiReply: vi.fn().mockResolvedValue(undefined),
  };
  const takeover = { noteHumanMessage: vi.fn().mockResolvedValue(undefined) };

  const service = new InstagramWebhookService(
    prisma as unknown as PrismaService,
    identity as unknown as InstagramIdentityService,
    mediaMirror as unknown as InstagramMediaMirrorService,
    comments as unknown as InstagramCommentsService,
    commentFunnel as unknown as CommentFunnelService,
    webhookDeliver as unknown as WebhookDeliverService,
    flowDispatch as unknown as FlowDispatchService,
    automationDispatch as unknown as AutomationDispatchService,
    aiReply as unknown as AiReplyService,
    takeover as unknown as HumanTakeoverService,
  );

  return {
    service,
    identity,
    takeover,
    mediaMirror,
    comments,
    webhookDeliver,
    flowDispatch,
    automationDispatch,
    aiReply,
  };
}

/** Wrap a messaging event in the webhook envelope. */
function envelope(messaging: unknown, entryId = IG_USER_ID) {
  return {
    object: 'instagram',
    entry: [{ id: entryId, messaging: [messaging] }],
  };
}

const inboundText = {
  sender: { id: CUSTOMER_IGSID },
  recipient: { id: IG_USER_ID },
  timestamp: 1785240000000,
  message: { mid: 'mid.inbound-1', text: 'hello there' },
};

/**
 * processWebhook is invoked fire-and-forget by handleWebhookReceived,
 * so tests drive the private method directly and await it.
 */
function runWebhook(service: InstagramWebhookService, body: unknown) {
  return (service as any).processWebhook(body);
}

describe('InstagramWebhookService — verification handshake', () => {
  const original = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
    } else {
      process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = original;
    }
  });

  it('echoes the challenge when the token matches', () => {
    process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = 'secret-token';
    const { service } = makeService(makePrismaMock());
    expect(
      service.handleVerification('subscribe', 'chal-123', 'secret-token'),
    ).toBe('chal-123');
  });

  it('rejects a mismatched token', () => {
    process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = 'secret-token';
    const { service } = makeService(makePrismaMock());
    expect(() =>
      service.handleVerification('subscribe', 'chal-123', 'wrong'),
    ).toThrow();
  });

  it('rejects a hub.mode that is not subscribe', () => {
    process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = 'secret-token';
    const { service } = makeService(makePrismaMock());
    expect(() =>
      service.handleVerification('unsubscribe', 'chal', 'secret-token'),
    ).toThrow();
  });

  it('rejects when no verify token is configured', () => {
    delete process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
    const { service } = makeService(makePrismaMock());
    // Fails closed: an unset env var must not make the empty string a
    // valid token, which would let anyone complete the handshake.
    expect(() => service.handleVerification('subscribe', 'chal', '')).toThrow();
  });
});

describe('InstagramWebhookService — routing', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  it('routes on entry.id matching either stored Instagram id', async () => {
    const { service } = makeService(prisma);
    await runWebhook(service, envelope(inboundText, IG_APP_SCOPED_ID));

    // The lookup must be an OR over both columns — matching only
    // ig_user_id silently drops every message for accounts whose
    // webhooks carry the app-scoped form.
    expect(prisma.instagram_config.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { ig_user_id: IG_APP_SCOPED_ID },
          { ig_app_scoped_id: IG_APP_SCOPED_ID },
        ],
      },
    });
    expect(prisma.messages.create).toHaveBeenCalled();
  });

  it('drops events for an unknown Instagram account', async () => {
    prisma.instagram_config.findFirst.mockResolvedValue(null);
    const { service } = makeService(prisma);
    await runWebhook(service, envelope(inboundText));
    expect(prisma.messages.create).not.toHaveBeenCalled();
  });

  it('survives a malformed entry without abandoning the batch', async () => {
    const { service } = makeService(prisma);
    await runWebhook(service, {
      object: 'instagram',
      entry: [
        { id: IG_USER_ID, messaging: [{ sender: {}, recipient: {} } as any] },
        { id: IG_USER_ID, messaging: [inboundText] },
      ],
    });
    // The good event still landed.
    expect(prisma.messages.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * The envelope Meta documents is not the only envelope Meta sends.
 *
 * On 2026-08-19 production took four Instagram messaging events with no
 * `sender` at all. `event.sender.id` threw a TypeError on each; the
 * controller had already answered 200, so all four were logged and lost
 * and the Instagram inbox stayed empty while the connection reported
 * itself healthy. One unparseable event must cost one event.
 */
describe('InstagramWebhookService — undocumented event shapes', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  it('⚠ does not throw on a messaging event with no sender', async () => {
    const { service } = makeService(prisma);

    await expect(
      runWebhook(
        service,
        envelope({
          recipient: { id: IG_USER_ID },
          timestamp: 1785240000000,
          message: { mid: 'mid.no-sender', text: 'hello there' },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('keeps processing the rest of the batch after an unparseable event', async () => {
    const { service } = makeService(prisma);

    await runWebhook(service, {
      object: 'instagram',
      entry: [
        {
          id: IG_USER_ID,
          messaging: [
            {
              recipient: { id: IG_USER_ID },
              message: { mid: 'm1', text: 'x' },
            },
          ],
        },
        { id: IG_USER_ID, messaging: [inboundText] },
      ],
    });

    expect(prisma.messages.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to the other side when the expected one is missing', async () => {
    const { service, identity } = makeService(prisma);

    // An echo names the customer as the recipient. With no recipient,
    // the sender is the only side left — and it is not us.
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        message: { mid: 'mid.echo-no-recipient', text: 'hi', is_echo: true },
      }),
    );

    expect(identity.findOrCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({ igsid: CUSTOMER_IGSID }),
    );
  });

  it('⚠ treats the business app-scoped id as the business, not a customer', async () => {
    const { service } = makeService(prisma);

    // Either stored id is us. Comparing against ig_user_id alone gave
    // the business a contact and a conversation of its own.
    await runWebhook(
      service,
      envelope({
        sender: { id: IG_APP_SCOPED_ID },
        recipient: { id: CUSTOMER_IGSID },
        message: { mid: 'mid.self-scoped', text: 'hello' },
      }),
    );

    expect(prisma.messages.create).not.toHaveBeenCalled();
  });
});

describe('InstagramWebhookService — inbound messages', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  it('stores an inbound text as a customer message and opens the reply window', async () => {
    const { service } = makeService(prisma);
    await runWebhook(service, envelope(inboundText));

    expect(prisma.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversation_id: CONVERSATION_ID,
          sender_type: 'customer',
          content_type: 'text',
          content_text: 'hello there',
          message_id: 'mid.inbound-1',
          status: 'delivered',
        }),
      }),
    );

    const update = prisma.conversations.update.mock.calls[0][0];
    expect(update.data.last_inbound_at).toBeInstanceOf(Date);
    expect(update.data.unread_count).toBe(1);
  });

  it('parses Instagram timestamps as milliseconds, not seconds', async () => {
    // WhatsApp sends epoch seconds, Instagram sends milliseconds.
    // Reusing the WhatsApp parsing puts every message in 1970.
    const { service } = makeService(prisma);
    await runWebhook(service, envelope(inboundText));

    const created = prisma.messages.create.mock.calls[0][0].data.created_at;
    expect(created.getUTCFullYear()).toBe(2026);
  });

  it('fans out to automations and the AI bot', async () => {
    const { service, automationDispatch, aiReply } = makeService(prisma);
    await runWebhook(service, envelope(inboundText));

    expect(automationDispatch.dispatch).toHaveBeenCalled();
    expect(aiReply.dispatchInboundToAiReply).toHaveBeenCalledTimes(1);
  });

  it('does NOT dispatch Instagram messages into the flow engine', async () => {
    // ⚠️ FLOWS ARE WHATSAPP-ONLY. Instagram used to reach the flow
    // engine, which let an author build a flow that sends a list, a
    // template or a catalogue — none of which exist here — and watch the
    // run fail mid-conversation. Automations are the channel-agnostic
    // engine and still run on every trigger.
    const { service, flowDispatch, automationDispatch } = makeService(prisma);

    await runWebhook(service, envelope(inboundText));

    expect(flowDispatch.dispatchInbound).not.toHaveBeenCalled();
    // And because no flow can consume the message, the reply-producing
    // triggers always fire on this channel.
    const fired = automationDispatch.dispatch.mock.calls.map(
      (c: any[]) => c[0].triggerType,
    );
    expect(fired).toContain('new_message_received');
    expect(fired).toContain('keyword_match');
  });

  it('tags automation dispatches with the instagram channel', async () => {
    const { service, automationDispatch } = makeService(prisma);
    await runWebhook(service, envelope(inboundText));

    expect(automationDispatch.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ channel: 'instagram' }),
      }),
    );
  });
});

describe('InstagramWebhookService — echoes', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  const echo = {
    sender: { id: IG_USER_ID },
    recipient: { id: CUSTOMER_IGSID },
    timestamp: 1785240000000,
    message: { mid: 'mid.echo-1', text: 'agent reply', is_echo: true },
  };

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  it('stores a reply sent from the Instagram app as an agent message', async () => {
    const { service } = makeService(prisma);
    await runWebhook(service, envelope(echo));

    expect(prisma.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sender_type: 'agent',
          content_text: 'agent reply',
          status: 'sent',
        }),
      }),
    );
  });

  it('does not duplicate a message we sent ourselves', async () => {
    // Our own send already wrote a row with this mid. Without this
    // check every agent reply appears twice in the inbox.
    prisma.messages.findFirst.mockResolvedValue({ id: 'existing-row' });
    const { service } = makeService(prisma);

    await runWebhook(service, envelope(echo));

    expect(prisma.messages.create).not.toHaveBeenCalled();
  });

  it('pauses the AI bot — an echo we did not send is a human on the app', async () => {
    // Someone replied from the Instagram app. That is a takeover just as
    // much as using the dashboard is, and the bot must not then open
    // with "Hi there! I'm your assistant" two messages later.
    const { service, takeover } = makeService(prisma);
    await runWebhook(service, envelope(echo));

    expect(takeover.noteHumanMessage).toHaveBeenCalledWith(
      expect.any(String),
      'echo',
    );
  });

  it('⚠ does NOT pause the bot on the echo of a message WE sent', async () => {
    // THE TRAP. Every AI reply comes back from Meta as an echo. If that
    // echo counted as a human takeover, the bot would switch itself off
    // the instant it first replied, on every thread, forever.
    //
    // The mid dedupe is the only thing preventing it: our own sends are
    // stored with the mid Meta returned, so their echo returns early.
    // This test is why that dedupe may not be "simplified".
    prisma.messages.findFirst.mockResolvedValue({ id: 'the-row-we-wrote' });
    const { service, takeover } = makeService(prisma);

    await runWebhook(service, envelope(echo));

    expect(takeover.noteHumanMessage).not.toHaveBeenCalled();
  });

  it('does not reopen the reply window', async () => {
    const { service } = makeService(prisma);
    await runWebhook(service, envelope(echo));

    const update = prisma.conversations.update.mock.calls[0][0];
    // The business talking to itself must not extend the 24h window.
    expect(update.data.last_inbound_at).toBeUndefined();
    expect(update.data.unread_count).toBeUndefined();
  });

  it('does not trigger flows, automations or the AI bot', async () => {
    const { service, flowDispatch, automationDispatch, aiReply } =
      makeService(prisma);
    await runWebhook(service, envelope(echo));

    // Otherwise the CRM answers its own outbound messages, forever.
    expect(flowDispatch.dispatchInbound).not.toHaveBeenCalled();
    expect(automationDispatch.dispatch).not.toHaveBeenCalled();
    expect(aiReply.dispatchInboundToAiReply).not.toHaveBeenCalled();
  });

  it('ignores self-messages entirely', async () => {
    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: IG_USER_ID },
        recipient: { id: IG_USER_ID },
        message: { mid: 'mid.self', text: 'note to self', is_self: true },
      }),
    );
    expect(prisma.messages.create).not.toHaveBeenCalled();
  });
});

describe('InstagramWebhookService — reactions', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    // The reaction target resolves to an existing message row.
    prisma.messages.findFirst.mockResolvedValue({ id: 'target-msg' });
  });

  it('stores the rendered emoji so both channels render identically', async () => {
    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        reaction: {
          mid: 'mid.target',
          action: 'react',
          reaction: 'love',
          emoji: '❤',
        },
      }),
    );

    expect(prisma.message_reactions.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { emoji: '❤' } }),
    );
  });

  it('falls back to the reaction name when Meta omits the emoji', async () => {
    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        reaction: { mid: 'mid.target', action: 'react', reaction: 'wow' },
      }),
    );

    expect(prisma.message_reactions.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { emoji: 'wow' } }),
    );
  });

  it('deletes the reaction on unreact', async () => {
    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        reaction: { mid: 'mid.target', action: 'unreact' },
      }),
    );

    expect(prisma.message_reactions.deleteMany).toHaveBeenCalled();
    expect(prisma.message_reactions.upsert).not.toHaveBeenCalled();
  });

  it('skips a reaction whose target message we never stored', async () => {
    prisma.messages.findFirst.mockResolvedValue(null);
    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        reaction: { mid: 'mid.unknown', action: 'react', emoji: '❤' },
      }),
    );

    expect(prisma.message_reactions.upsert).not.toHaveBeenCalled();
  });
});

describe('InstagramWebhookService — read receipts, edits, deletions', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  it('marks outbound messages read up to the seen mid', async () => {
    const readAt = new Date('2026-07-28T10:00:00.000Z');
    prisma.messages.findFirst.mockResolvedValue({ created_at: readAt });

    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        read: { mid: 'mid.seen' },
      }),
    );

    expect(prisma.messages.updateMany).toHaveBeenCalledWith({
      where: {
        conversation_id: CONVERSATION_ID,
        sender_type: { not: 'customer' },
        created_at: { lte: readAt },
        status: { not: 'read' },
      },
      data: { status: 'read' },
    });
  });

  it('marks everything read when the seen mid is unknown', async () => {
    // Happens for messages sent from the Instagram app before the
    // account was connected. The customer has clearly caught up.
    prisma.messages.findFirst.mockResolvedValue(null);
    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        read: { mid: 'mid.never-stored' },
      }),
    );

    expect(prisma.messages.updateMany).toHaveBeenCalled();
  });

  it('keeps the original text when a message is edited', async () => {
    prisma.messages.findFirst.mockResolvedValue({
      id: 'msg-row-1',
      content_text: 'original',
      metadata: null,
    });

    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        message_edit: { mid: 'mid.edited', text: 'edited', num_edit: 1 },
      }),
    );

    const data = prisma.messages.update.mock.calls[0][0].data;
    expect(data.content_text).toBe('edited');
    // "They edited it after I replied" is a real support scenario.
    expect(data.metadata.original_text).toBe('original');
  });

  it('tombstones rather than deletes a removed message', async () => {
    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        message: { mid: 'mid.gone', is_deleted: true },
      }),
    );

    expect(prisma.messages.updateMany).toHaveBeenCalledWith({
      where: { message_id: 'mid.gone', deleted_at: null },
      data: { deleted_at: expect.any(Date) },
    });
    expect(prisma.messages.create).not.toHaveBeenCalled();
  });
});

describe('InstagramWebhookService — postbacks and story replies', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  it('models an ice-breaker tap as an interactive reply', async () => {
    const { service, flowDispatch } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        postback: {
          mid: 'mid.postback',
          title: 'See pricing',
          payload: 'SHOW_PRICING',
        },
      }),
    );

    expect(prisma.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content_type: 'interactive',
          interactive_reply_id: 'SHOW_PRICING',
        }),
      }),
    );

    // The payload is carried through as an interactive reply id, which
    // is what an automation's keyword/postback handling reads. It no
    // longer reaches the flow engine — flows are WhatsApp-only.
    expect(flowDispatch.dispatchInbound).not.toHaveBeenCalled();
  });

  it('keeps story context on a story reply', async () => {
    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        message: {
          mid: 'mid.story-reply',
          text: 'love this!',
          reply_to: { story: { id: 'story-1', url: 'https://cdn/story.jpg' } },
        },
      }),
    );

    const data = prisma.messages.create.mock.calls[0][0].data;
    expect(data.metadata.ig_reply_to_story).toEqual({
      id: 'story-1',
      url: 'https://cdn/story.jpg',
    });
  });

  it('treats a quick-reply payload as an interactive reply', async () => {
    const { service } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        message: {
          mid: 'mid.qr',
          text: 'Yes please',
          quick_reply: { payload: 'OPT_YES' },
        },
      }),
    );

    expect(prisma.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ interactive_reply_id: 'OPT_YES' }),
      }),
    );
  });
});

describe('InstagramWebhookService — attachments', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  it('mirrors an image and stores the durable URL', async () => {
    const { service, mediaMirror } = makeService(prisma);
    mediaMirror.mirror.mockResolvedValue('https://storage/mirrored.jpg');

    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        message: {
          mid: 'mid.image',
          attachments: [
            {
              type: 'image',
              payload: { url: 'https://cdn.instagram/expiring.jpg' },
            },
          ],
        },
      }),
    );

    const data = prisma.messages.create.mock.calls[0][0].data;
    expect(data.content_type).toBe('image');
    expect(data.media_url).toBe('https://storage/mirrored.jpg');
  });

  it('falls back to the CDN URL when mirroring fails', async () => {
    // A broken thumbnail tomorrow beats no message at all today.
    const { service, mediaMirror } = makeService(prisma);
    mediaMirror.mirror.mockResolvedValue(null);

    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        message: {
          mid: 'mid.image-2',
          attachments: [
            {
              type: 'image',
              payload: { url: 'https://cdn.instagram/expiring.jpg' },
            },
          ],
        },
      }),
    );

    expect(prisma.messages.create.mock.calls[0][0].data.media_url).toBe(
      'https://cdn.instagram/expiring.jpg',
    );
  });

  /**
   * The `data` of the first messages.create, typed.
   *
   * The mock is `any`, so reaching into it directly spreads
   * unsafe-member-access through every assertion. One cast here keeps
   * the tests below readable and checked.
   */
  function createdMessage(client: typeof prisma): Record<string, unknown> {
    const create = client.messages.create as unknown as {
      mock: { calls: Array<[{ data: Record<string, unknown> }]> };
    };
    return create.mock.calls[0][0].data;
  }

  it('keeps a shared reel as a link and never copies the video', async () => {
    // `payload.url` on a reel share is a PERMALINK, not a media file.
    // Storing it in media_url is what made the inbox render
    // <video src="https://www.instagram.com/reel/…"> and paint empty
    // player chrome forever.
    const { service, mediaMirror } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        message: {
          mid: 'mid.reel',
          attachments: [
            {
              type: 'ig_reel',
              payload: {
                url: 'https://www.instagram.com/reel/DbBDpvIpiv_/',
                title: 'Can Your Thaali Chain Cause Neck Darkening?',
              },
            },
          ],
        },
      }),
    );

    const data = createdMessage(prisma);
    expect(data.content_type).toBe('share');
    // The whole point: Instagram is already hosting it. A busy account
    // forwarding reels must not grow our storage.
    expect(data.media_url).toBeNull();
    expect(mediaMirror.mirror).not.toHaveBeenCalled();
    expect(data.metadata).toMatchObject({
      ig_attachment_type: 'ig_reel',
      ig_permalink: 'https://www.instagram.com/reel/DbBDpvIpiv_/',
    });
  });

  it('does not copy bytes for an attachment type it does not recognise', async () => {
    // The expensive bug. Anything Meta invented since we last looked
    // fell through to kind:'file' and had up to 30 MB mirrored — then
    // rendered as a bare paragraph, so nobody ever saw what we paid for.
    const { service, mediaMirror } = makeService(prisma);
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        message: {
          mid: 'mid.unknown',
          attachments: [
            { type: 'some_new_thing', payload: { url: 'https://cdn/x.mp4' } },
          ],
        },
      }),
    );

    const data = createdMessage(prisma);
    expect(data.content_type).toBe('unsupported');
    expect(data.media_url).toBeNull();
    expect(mediaMirror.mirror).not.toHaveBeenCalled();
  });

  it('still copies a genuine attachment the customer sent', async () => {
    // The allowlist must not throw the baby out: a photo sent into the
    // thread has an expiring URL and no id to re-resolve it from, so
    // not copying it means losing it.
    const { service, mediaMirror } = makeService(prisma);
    mediaMirror.mirror.mockResolvedValue('https://storage/mirrored.jpg');
    await runWebhook(
      service,
      envelope({
        sender: { id: CUSTOMER_IGSID },
        recipient: { id: IG_USER_ID },
        message: {
          mid: 'mid.photo',
          attachments: [
            { type: 'image', payload: { url: 'https://cdn/photo.jpg' } },
          ],
        },
      }),
    );

    expect(mediaMirror.mirror).toHaveBeenCalled();
    expect(createdMessage(prisma).media_url).toBe('https://storage/mirrored.jpg');
  });
});

describe('InstagramWebhookService — comments', () => {
  it('forwards a flat comments event to the comments service', async () => {
    const prisma = makePrismaMock();
    const { service, comments } = makeService(prisma);

    await runWebhook(service, {
      object: 'instagram',
      entry: [
        {
          id: IG_USER_ID,
          field: 'comments',
          value: {
            id: 'comment-1',
            from: { id: CUSTOMER_IGSID, username: 'siva19' },
            text: 'how much?',
            media: { id: 'media-1' },
          },
        },
      ],
    });

    expect(comments.ingestWebhookComment).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'comments' }),
    );
  });

  it('forwards a changes-wrapped comments event too', async () => {
    // The envelope shape varies by Graph version; both must work.
    const prisma = makePrismaMock();
    const { service, comments } = makeService(prisma);

    await runWebhook(service, {
      object: 'instagram',
      entry: [
        {
          id: IG_USER_ID,
          changes: [
            { field: 'comments', value: { id: 'comment-2', text: 'nice' } },
          ],
        },
      ],
    });

    expect(comments.ingestWebhookComment).toHaveBeenCalledTimes(1);
  });
});
