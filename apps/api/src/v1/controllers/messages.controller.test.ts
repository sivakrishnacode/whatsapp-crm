import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

// The phone → contact/conversation resolution has its own tests and its
// own Prisma surface; here it only has to hand back a conversation.
vi.mock('../utils/resolve-conversation.util', () => ({
  resolveConversationByPhone: vi.fn().mockResolvedValue({
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactCreated: false,
  }),
}));

import { MessagesController } from './messages.controller';
import { MessageSendService } from '../services/message-send.service';
import type { WebhookDeliverService } from '../services/webhook-deliver.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { InstagramSendService } from '../../instagram/services/instagram-send.service';
import type { EntitlementService } from '../../subscription/services/entitlement.service';
import type { AccountContext } from '../../auth/types/account-context.type';
import { encrypt } from '../../common/security/encryption.util';
import { ApiError } from '../utils/respond.util';

const ACCOUNT = 'acc-1';
const CTX = {
  authType: 'api_key',
  accountId: ACCOUNT,
} as unknown as AccountContext;

/** A copy-code AUTHENTICATION template row as "Sync from Meta" writes it. */
const authTemplateRow = {
  id: 'tpl-otp',
  user_id: 'user-1',
  account_id: ACCOUNT,
  name: 'dffrnt_login_otp',
  category: 'Authentication',
  language: 'en_US',
  header_type: null,
  header_content: null,
  header_handle: null,
  header_media_url: null,
  body_text:
    '*{{1}}* is your verification code. For your security, do not share this code.',
  footer_text: 'This code expires in 10 minutes.',
  buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
  sample_values: { body: ['123456'] },
  parameter_format: 'POSITIONAL',
  cards: null,
  status: 'APPROVED',
  meta_template_id: '1234567890',
};

/** The bits of the `messages.create` argument these tests read. */
interface CreatedMessage {
  data: {
    content_type: string;
    content_text: string | null;
    template_name: string | null;
    message_id: string;
    metadata: { template: Record<string, unknown> };
  };
}

function makePrisma() {
  return {
    conversations: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'conv-1',
        account_id: ACCOUNT,
        channel: 'whatsapp',
        contacts: { id: 'contact-1', phone: '+919876543210' },
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    whatsapp_config: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'cfg-1',
        account_id: ACCOUNT,
        phone_number_id: 'pn-1',
        access_token: encrypt('meta-token'),
        catalog_id: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    message_templates: {
      findFirst: vi.fn().mockResolvedValue(authTemplateRow),
    },
    messages: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    },
    contacts: { update: vi.fn().mockResolvedValue({}) },
    flowRun: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
}

const fetchMock = vi.fn();

function metaOk(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ messages: [{ id: 'wamid.OTP1' }] }),
  } as unknown as Response;
}

/** The JSON body of the Nth request made to Meta. */
function sentToMeta(n = 0): {
  template: { components: unknown[] } & Record<string, unknown>;
} & Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return JSON.parse(init.body as string) as ReturnType<typeof sentToMeta>;
}

function setup() {
  const prisma = makePrisma();
  const entitlements = { recordUsage: vi.fn().mockResolvedValue(undefined) };
  const service = new MessageSendService(
    prisma as unknown as PrismaService,
    {} as unknown as InstagramSendService,
    entitlements as unknown as EntitlementService,
  );
  const controller = new MessagesController(
    prisma as unknown as PrismaService,
    {} as unknown as WebhookDeliverService,
    service,
  );
  const res = { status: vi.fn() };
  return { prisma, controller, res, resArg: res as unknown as Response };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/v1/messages — AUTHENTICATION template', () => {
  it('sends Meta the code in the body and on the OTP button', async () => {
    fetchMock.mockResolvedValue(metaOk());
    const { prisma, controller, res, resArg } = setup();

    // Exactly the body DFFRNT sends for its login OTP, through a JSON
    // round trip so buttonParams is keyed by the string "0".
    const body: unknown = JSON.parse(
      JSON.stringify({
        to: '+919876543210',
        type: 'template',
        template: {
          name: 'dffrnt_login_otp',
          language: 'en_US',
          params: { body: ['123456'], buttonParams: { '0': '123456' } },
        },
      }),
    );

    const result = await controller.sendMessage(CTX, body, resArg);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(result).toMatchObject({
      data: {
        message_id: 'msg-1',
        whatsapp_message_id: 'wamid.OTP1',
        conversation_id: 'conv-1',
      },
    });

    expect(prisma.message_templates.findFirst).toHaveBeenCalledWith({
      where: {
        account_id: ACCOUNT,
        name: 'dffrnt_login_otp',
        language: 'en_US',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/pn-1\/messages$/);
    expect(sentToMeta()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'dffrnt_login_otp',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '123456' }],
          },
        ],
      },
    });
  });

  it('stores the rendered body and a "Copy code" button for the inbox', async () => {
    fetchMock.mockResolvedValue(metaOk());
    const { prisma, controller, resArg } = setup();

    await controller.sendMessage(
      CTX,
      {
        to: '+919876543210',
        type: 'template',
        template: {
          name: 'dffrnt_login_otp',
          language: 'en_US',
          params: { body: ['123456'], buttonParams: { '0': '123456' } },
        },
      },
      resArg,
    );

    const [created] = prisma.messages.create.mock.calls[0] as [CreatedMessage];
    expect(created.data).toMatchObject({
      content_type: 'template',
      template_name: 'dffrnt_login_otp',
      message_id: 'wamid.OTP1',
      content_text:
        '*123456* is your verification code. For your security, do not share this code.',
    });
    expect(created.data.metadata.template).toMatchObject({
      name: 'dffrnt_login_otp',
      footer: 'This code expires in 10 minutes.',
      buttons: [{ type: 'COPY_CODE', text: 'Copy code' }],
    });
  });

  it('still sends when only the body carries the code', async () => {
    fetchMock.mockResolvedValue(metaOk());
    const { controller, resArg } = setup();

    await controller.sendMessage(
      CTX,
      {
        to: '+919876543210',
        type: 'template',
        template: {
          name: 'dffrnt_login_otp',
          language: 'en_US',
          params: { body: ['654321'] },
        },
      },
      resArg,
    );

    expect(sentToMeta().template.components[1]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: '654321' }],
    });
  });

  it('refuses before calling Meta when no code is supplied', async () => {
    const { prisma, controller, resArg } = setup();

    const err: unknown = await controller
      .sendMessage(
        CTX,
        {
          to: '+919876543210',
          type: 'template',
          template: { name: 'dffrnt_login_otp', language: 'en_US' },
        },
        resArg,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const response = (err as ApiError).getResponse() as {
      error: { message: string };
    };
    expect(response.error.message).toMatch(/Body has 1 variable/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.messages.create).not.toHaveBeenCalled();
  });
});
