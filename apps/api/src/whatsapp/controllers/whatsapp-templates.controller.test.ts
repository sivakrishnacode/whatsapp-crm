import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { WhatsappTemplatesController } from './whatsapp-templates.controller';
import { encrypt } from '../../common/security/encryption.util';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';

const ACCOUNT = 'acc-1';

/**
 * A copy-code AUTHENTICATION template exactly as Meta's
 * GET /{waba_id}/message_templates returns it — created in WhatsApp
 * Manager, since Converse360 refuses to submit this category itself.
 */
const metaAuthTemplate = {
  id: '1234567890',
  name: 'dffrnt_login_otp',
  language: 'en_US',
  status: 'APPROVED',
  category: 'AUTHENTICATION',
  parameter_format: 'POSITIONAL',
  components: [
    {
      type: 'BODY',
      text: '*{{1}}* is your verification code. For your security, do not share this code.',
      add_security_recommendation: true,
      example: { body_text: [['123456']] },
    },
    {
      type: 'FOOTER',
      text: 'This code expires in 10 minutes.',
      code_expiration_minutes: 10,
    },
    {
      type: 'BUTTONS',
      buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
    },
  ],
};

const fetchMock = vi.fn();

function makePrisma() {
  return {
    whatsapp_config: {
      findUnique: vi.fn().mockResolvedValue({
        account_id: ACCOUNT,
        waba_id: 'waba-1',
        access_token: encrypt('meta-token'),
      }),
    },
    message_templates: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/whatsapp/templates/sync — AUTHENTICATION templates', () => {
  it('stores the category, body, footer and OTP button', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [metaAuthTemplate], paging: {} }),
    });
    const prisma = makePrisma();
    const controller = new WhatsappTemplatesController(
      prisma as unknown as PrismaService,
    );
    const res = makeRes();

    await controller.sync(
      { accountId: ACCOUNT, userId: 'user-1' } as SupabaseAccountContext,
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, total: 1, inserted: 1 }),
    );

    // The pull asks for components, which is where the button lives.
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/waba-1/message_templates?');
    expect(url).toContain('components');

    const [created] = prisma.message_templates.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(created.data).toMatchObject({
      account_id: ACCOUNT,
      name: 'dffrnt_login_otp',
      language: 'en_US',
      category: 'Authentication',
      status: 'APPROVED',
      meta_template_id: '1234567890',
      body_text:
        '*{{1}}* is your verification code. For your security, do not share this code.',
      footer_text: 'This code expires in 10 minutes.',
      buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
      sample_values: { body: ['123456'] },
      parameter_format: 'POSITIONAL',
    });
  });
});
