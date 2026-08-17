import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS, type BuiltinToolContext } from './builtin';
import type { PrismaService } from '../../../prisma/prisma.service';

/**
 * `create_deal` shipped with `pipeline_id` and `stage_id` as REQUIRED tool
 * parameters, and nothing a model can reach knows either one: no tool
 * lists pipelines, the skill prompt never mentioned ids, and a UUID is
 * not something a customer says. So every call either omitted them and
 * failed validation or invented one and failed the lookup — while the
 * skill read as enabled in the studio. A failed tool result is only ever
 * shown to the MODEL, so the whole feature was silently inert.
 *
 * These tests pin the two halves of the fix that must not regress:
 * the destination is resolved SERVER-side, and an id that came from
 * configuration is still validated against the account.
 */

const ACCOUNT = 'acc-1';
const createDeal = BUILTIN_TOOLS.create_deal;

interface Fixture {
  pipelines: Array<{
    id: string;
    name: string;
    account_id: string;
    created_at: Date;
  }>;
  stages: Array<{
    id: string;
    name: string;
    pipeline_id: string;
    position: number;
  }>;
}

/** Enough Prisma to answer the four queries the tool makes. */
function fakePrisma(fx: Fixture) {
  const created: Record<string, unknown>[] = [];

  const prisma = {
    pipelines: {
      findFirst: ({ where, orderBy }: any) => {
        let rows = fx.pipelines.filter((p) =>
          where.account_id === undefined
            ? true
            : p.account_id === where.account_id,
        );
        if (where.id !== undefined) rows = rows.filter((p) => p.id === where.id);
        if (orderBy?.created_at === 'asc') {
          rows = [...rows].sort(
            (a, b) => a.created_at.getTime() - b.created_at.getTime(),
          );
        }
        return Promise.resolve(rows[0] ?? null);
      },
    },
    pipeline_stages: {
      findFirst: ({ where, orderBy }: any) => {
        let rows = fx.stages.filter((s) => s.pipeline_id === where.pipeline_id);
        if (where.id !== undefined) rows = rows.filter((s) => s.id === where.id);
        if (orderBy?.position === 'asc') {
          rows = [...rows].sort((a, b) => a.position - b.position);
        }
        return Promise.resolve(rows[0] ?? null);
      },
    },
    account: {
      findUnique: () => Promise.resolve({ ownerUserId: 'owner-1' }),
    },
    deals: {
      create: ({ data }: any) => {
        created.push(data);
        return Promise.resolve({
          id: 'deal-1',
          title: data.title,
          value: data.value,
        });
      },
    },
  };

  return { prisma: prisma as unknown as PrismaService, created };
}

function ctxWith(
  prisma: PrismaService,
  dealConfig: Record<string, unknown> = {},
): BuiltinToolContext {
  return {
    prisma,
    accountId: ACCOUNT,
    contactId: 'contact-1',
    actorUserId: 'owner-1',
    currency: 'INR',
    skills: { create_deal: { enabled: true, config: dealConfig } },
  };
}

/** Two pipelines and two stages, deliberately out of natural order. */
function standardFixture(): Fixture {
  return {
    pipelines: [
      {
        id: 'pipe-new',
        name: 'Newer',
        account_id: ACCOUNT,
        created_at: new Date('2026-02-01'),
      },
      {
        id: 'pipe-old',
        name: 'Sales',
        account_id: ACCOUNT,
        created_at: new Date('2026-01-01'),
      },
      {
        id: 'pipe-other-tenant',
        name: 'Someone else',
        account_id: 'acc-2',
        created_at: new Date('2025-01-01'),
      },
    ],
    stages: [
      { id: 'stage-2', name: 'Qualified', pipeline_id: 'pipe-old', position: 1 },
      { id: 'stage-1', name: 'New', pipeline_id: 'pipe-old', position: 0 },
      { id: 'stage-new-1', name: 'Inbox', pipeline_id: 'pipe-new', position: 0 },
    ],
  };
}

describe('create_deal', () => {
  it('creates a deal from a title alone — no ids from the model', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    const result = await createDeal.run(
      { title: 'CRM build', value: 50000, notes: 'Needs it within 1 month' },
      ctxWith(prisma),
    );

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    // The workspace's OLDEST pipeline and its FIRST stage by position —
    // not whichever row the database happened to return first.
    expect(created[0]).toMatchObject({
      account_id: ACCOUNT,
      pipeline_id: 'pipe-old',
      stage_id: 'stage-1',
      contact_id: 'contact-1',
      title: 'CRM build',
      value: 50000,
      currency: 'INR',
      status: 'open',
    });
  });

  it('files into the configured pipeline and stage when an admin set them', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    const result = await createDeal.run(
      { title: 'CRM build' },
      ctxWith(prisma, {
        deal_pipeline_id: 'pipe-new',
        deal_stage_id: 'stage-new-1',
      }),
    );

    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({
      pipeline_id: 'pipe-new',
      stage_id: 'stage-new-1',
    });
  });

  it("refuses a configured pipeline belonging to another account", async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    const result = await createDeal.run(
      { title: 'CRM build' },
      ctxWith(prisma, { deal_pipeline_id: 'pipe-other-tenant' }),
    );

    // Not "fall back to our own default": a configured id pointing
    // somewhere it must not is a mistake worth surfacing, and writing the
    // deal elsewhere would hide it.
    expect(result.ok).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('falls back to the first stage when the configured one is from another pipeline', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    const result = await createDeal.run(
      { title: 'CRM build' },
      ctxWith(prisma, {
        deal_pipeline_id: 'pipe-old',
        // Belongs to pipe-new — stale config after a pipeline was rebuilt.
        deal_stage_id: 'stage-new-1',
      }),
    );

    // A deal the conversation already earned must not be lost to stale
    // config, so this lands at the pipeline's first stage.
    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({
      pipeline_id: 'pipe-old',
      stage_id: 'stage-1',
    });
  });

  it('says so plainly when the workspace has no pipeline at all', async () => {
    const { prisma, created } = fakePrisma({ pipelines: [], stages: [] });

    const result = await createDeal.run({ title: 'CRM build' }, ctxWith(prisma));

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no pipeline/i);
    expect(created).toHaveLength(0);
  });

  it('still requires a title', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    const result = await createDeal.run({ value: 50000 }, ctxWith(prisma));

    expect(result.ok).toBe(false);
    expect(created).toHaveLength(0);
  });
});
