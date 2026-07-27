import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { WhatsappFlowsController } from './whatsapp-flows.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SupabaseAccountContext } from '../../auth/types/account-context.type';

// The controller must never build a Meta request itself — it delegates to
// the util. Mock the whole util so we assert delegation + argument shaping.
vi.mock('../meta-flows-api.util', () => ({
  listFlows: vi.fn(),
  getFlowDetails: vi.fn(),
  getFlowPreview: vi.fn(),
  downloadFlowJson: vi.fn(),
  createFlow: vi.fn(),
  updateFlowMetadata: vi.fn(),
  updateFlowJson: vi.fn(),
  publishFlow: vi.fn(),
  deprecateFlow: vi.fn(),
  deleteFlow: vi.fn(),
}));

vi.mock('../../common/security/encryption.util', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
}));

import { listFlows, createFlow } from '../meta-flows-api.util';

const account: SupabaseAccountContext = {
  authType: 'supabase',
  userId: 'user-1',
  accountId: 'acc-1',
  role: 'admin',
  account: { id: 'acc-1', name: 'Test' },
};

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

function makePrismaMock(config: unknown) {
  return {
    whatsapp_config: {
      findUnique: vi.fn().mockResolvedValue(config),
    },
  };
}

describe('WhatsappFlowsController', () => {
  let controller: WhatsappFlowsController;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when WhatsApp is not configured', async () => {
    const prisma = makePrismaMock(null);
    controller = new WhatsappFlowsController(
      prisma as unknown as PrismaService,
    );
    const res = makeRes();

    await controller.list(account, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(listFlows).not.toHaveBeenCalled();
  });

  it('returns 400 when the account has no waba_id', async () => {
    const prisma = makePrismaMock({ waba_id: null, access_token: 'enc' });
    controller = new WhatsappFlowsController(
      prisma as unknown as PrismaService,
    );
    const res = makeRes();

    await controller.list(account, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(listFlows).not.toHaveBeenCalled();
  });

  it('lists flows with the decrypted token when configured', async () => {
    const prisma = makePrismaMock({ waba_id: 'waba-1', access_token: 'enc' });
    controller = new WhatsappFlowsController(
      prisma as unknown as PrismaService,
    );
    const res = makeRes();
    vi.mocked(listFlows).mockResolvedValue([
      {
        id: 'f1',
        name: 'A',
        status: 'DRAFT',
        categories: [],
        validation_errors: [],
      },
    ]);

    await controller.list(account, res);

    expect(listFlows).toHaveBeenCalledWith({
      wabaId: 'waba-1',
      accessToken: 'decrypted:enc',
    });
    expect(res.json).toHaveBeenCalledWith({
      flows: [
        {
          id: 'f1',
          name: 'A',
          status: 'DRAFT',
          categories: [],
          validation_errors: [],
        },
      ],
    });
  });

  it('create from a template seeds flow_json + category', async () => {
    const prisma = makePrismaMock({ waba_id: 'waba-1', access_token: 'enc' });
    controller = new WhatsappFlowsController(
      prisma as unknown as PrismaService,
    );
    const res = makeRes();
    vi.mocked(createFlow).mockResolvedValue({
      id: 'new-1',
      validation_errors: [],
    });

    await controller.create(
      account,
      { name: 'Welcome', templateId: 'blank' },
      res,
    );

    expect(createFlow).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(createFlow).mock.calls[0][0];
    expect(arg.name).toBe('Welcome');
    expect(arg.categories).toEqual(['OTHER']);
    expect(arg.flowJson).toContain('WELCOME_SCREEN');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rejects an unknown template id with 400', async () => {
    const prisma = makePrismaMock({ waba_id: 'waba-1', access_token: 'enc' });
    controller = new WhatsappFlowsController(
      prisma as unknown as PrismaService,
    );
    const res = makeRes();

    await controller.create(
      account,
      { name: 'X', templateId: 'does-not-exist' },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createFlow).not.toHaveBeenCalled();
  });

  it('maps a thrown Meta error to 502', async () => {
    const prisma = makePrismaMock({ waba_id: 'waba-1', access_token: 'enc' });
    controller = new WhatsappFlowsController(
      prisma as unknown as PrismaService,
    );
    const res = makeRes();
    vi.mocked(listFlows).mockRejectedValue(new Error('token expired'));

    await controller.list(account, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: 'token expired' });
  });
});
