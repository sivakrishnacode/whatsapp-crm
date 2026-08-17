import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS, type BuiltinToolContext } from './builtin';
import type { PrismaService } from '../../../prisma/prisma.service';

/**
 * The two deal tools shipped unable to do their job, in three ways that
 * every share one root: an id the MODEL cannot possibly know was made a
 * required argument, and the failure was invisible because a tool result
 * is only ever read by the model.
 *
 *   1. `create_deal` required `pipeline_id` + `stage_id`. Nothing lists
 *      pipelines, so every call failed validation or invented a UUID.
 *   2. `create_deal` then wrote the owner's USER id into
 *      `deals.assigned_to`, which references `profiles(id)` — a foreign
 *      key violation, so even a call that got past (1) created nothing.
 *   3. `assign_deal` required a `profiles.id`, and its "is this a member
 *      of this account" check had NO account filter — a guessed id from
 *      another tenant passed it.
 *
 * These tests pin all three fixes. Note the fake below does not enforce
 * foreign keys, which is exactly why (2) survived the first round of
 * tests — so the `assigned_to` assertions name the profile id explicitly.
 */

const ACCOUNT = 'acc-1';
const OWNER_USER = 'user-owner';
const OWNER_PROFILE = 'profile-owner';

const createDeal = BUILTIN_TOOLS.create_deal;
const assignDeal = BUILTIN_TOOLS.assign_deal;

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
  profiles: Array<{
    id: string;
    userId: string;
    accountId: string;
    fullName: string;
    email: string;
  }>;
  deals: Array<{
    id: string;
    title: string;
    account_id: string;
    contact_id: string | null;
    conversation_id: string | null;
    status: string;
    created_at: Date;
    assigned_to: string | null;
    value: number;
    notes: string | null;
  }>;
}

function matches(text: string, cond: any): boolean {
  if (cond?.equals !== undefined) {
    return cond.mode === 'insensitive'
      ? text.toLowerCase() === String(cond.equals).toLowerCase()
      : text === cond.equals;
  }
  if (cond?.contains !== undefined) {
    return cond.mode === 'insensitive'
      ? text.toLowerCase().includes(String(cond.contains).toLowerCase())
      : text.includes(cond.contains);
  }
  return text === cond;
}

/** Enough Prisma to answer the queries the two tools make. */
function fakePrisma(fx: Fixture) {
  const created: Record<string, unknown>[] = [];
  const updated: Array<{ id: string; data: Record<string, unknown> }> = [];

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
      findUnique: () => Promise.resolve({ ownerUserId: OWNER_USER }),
    },
    profile: {
      findFirst: ({ where }: any) =>
        Promise.resolve(
          fx.profiles.find(
            (p) =>
              p.userId === where.userId && p.accountId === where.accountId,
          ) ?? null,
        ),
      findMany: ({ where, take }: any) => {
        const rows = fx.profiles
          .filter((p) => p.accountId === where.accountId)
          .filter((p) =>
            (where.OR as any[]).some((clause) =>
              clause.email
                ? matches(p.email, clause.email)
                : matches(p.fullName, clause.fullName),
            ),
          );
        return Promise.resolve(rows.slice(0, take ?? rows.length));
      },
    },
    deals: {
      findFirst: ({ where, orderBy }: any) => {
        let rows = fx.deals.filter((d) => d.account_id === where.account_id);
        if (where.id !== undefined) rows = rows.filter((d) => d.id === where.id);
        if (where.contact_id !== undefined) {
          rows = rows.filter((d) => d.contact_id === where.contact_id);
        }
        if (where.conversation_id !== undefined) {
          rows = rows.filter((d) => d.conversation_id === where.conversation_id);
        }
        if (where.status !== undefined) {
          rows = rows.filter((d) => d.status === where.status);
        }
        if (orderBy?.created_at === 'desc') {
          rows = [...rows].sort(
            (a, b) => b.created_at.getTime() - a.created_at.getTime(),
          );
        }
        return Promise.resolve(rows[0] ?? null);
      },
      create: ({ data }: any) => {
        created.push(data);
        return Promise.resolve({
          id: 'deal-new',
          title: data.title,
          value: data.value,
        });
      },
      update: ({ where, data }: any) => {
        updated.push({ id: where.id, data });
        return Promise.resolve({ id: where.id });
      },
    },
  };

  return { prisma: prisma as unknown as PrismaService, created, updated };
}

function ctxWith(
  prisma: PrismaService,
  opts: {
    dealConfig?: Record<string, unknown>;
    contactId?: string | null;
    conversationId?: string | null;
  } = {},
): BuiltinToolContext {
  return {
    prisma,
    accountId: ACCOUNT,
    contactId: opts.contactId === undefined ? 'contact-1' : opts.contactId,
    conversationId:
      opts.conversationId === undefined ? 'conv-fresh' : opts.conversationId,
    actorUserId: OWNER_USER,
    currency: 'INR',
    skills: {
      create_deal: { enabled: true, config: opts.dealConfig ?? {} },
      assign_deal_to_member: { enabled: true, config: {} },
    },
  };
}

/** Deliberately out of natural order, and with a second tenant present. */
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
    profiles: [
      {
        id: OWNER_PROFILE,
        userId: OWNER_USER,
        accountId: ACCOUNT,
        fullName: 'Siva Krishna',
        email: 'siva@acme.test',
      },
      {
        id: 'profile-priya',
        userId: 'user-priya',
        accountId: ACCOUNT,
        fullName: 'Priya Nair',
        email: 'priya@acme.test',
      },
      {
        id: 'profile-outsider',
        userId: 'user-outsider',
        accountId: 'acc-2',
        fullName: 'Priya Sharma',
        email: 'priya@other.test',
      },
    ],
    deals: [
      {
        id: 'deal-old',
        title: 'Old enquiry',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        conversation_id: 'conv-old',
        status: 'open',
        created_at: new Date('2026-01-05'),
        assigned_to: null,
        value: 1000,
        notes: 'Original enquiry',
      },
      {
        id: 'deal-latest',
        title: 'CRM build',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        conversation_id: 'conv-taken',
        status: 'open',
        created_at: new Date('2026-02-05'),
        assigned_to: null,
        value: 50000,
        notes: 'Wants it in 1 month',
      },
      {
        id: 'deal-won',
        title: 'Closed job',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        conversation_id: 'conv-closed',
        status: 'won',
        created_at: new Date('2026-02-04'),
        assigned_to: null,
        value: 999,
        notes: null,
      },
      {
        id: 'deal-other-tenant',
        title: 'Not ours',
        account_id: 'acc-2',
        contact_id: 'contact-9',
        conversation_id: 'conv-theirs',
        status: 'open',
        created_at: new Date('2026-02-06'),
        assigned_to: null,
        value: 777,
        notes: null,
      },
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

  it('assigns to the owner PROFILE id, not their user id', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    await createDeal.run({ title: 'CRM build' }, ctxWith(prisma));

    // `deals.assigned_to` references profiles(id); `user_id` references
    // auth.users. Writing the user id into both is an FK violation, which
    // is what stopped every deal being created.
    expect(created[0]).toMatchObject({
      user_id: OWNER_USER,
      assigned_to: OWNER_PROFILE,
    });
    expect(created[0].assigned_to).not.toBe(OWNER_USER);
  });

  it('still creates the deal when the owner has no profile row', async () => {
    const fx = standardFixture();
    fx.profiles = fx.profiles.filter((p) => p.id !== OWNER_PROFILE);
    const { prisma, created } = fakePrisma(fx);

    const result = await createDeal.run({ title: 'CRM build' }, ctxWith(prisma));

    // Unassigned beats absent.
    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({ assigned_to: null });
  });

  it('returns the deal id so assign_deal can chain off it', async () => {
    const { prisma } = fakePrisma(standardFixture());

    const result = await createDeal.run({ title: 'CRM build' }, ctxWith(prisma));

    expect(result.detail).toContain('deal-new');
  });

  it('files into the configured pipeline and stage when an admin set them', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    const result = await createDeal.run(
      { title: 'CRM build' },
      ctxWith(prisma, {
        dealConfig: {
          deal_pipeline_id: 'pipe-new',
          deal_stage_id: 'stage-new-1',
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({
      pipeline_id: 'pipe-new',
      stage_id: 'stage-new-1',
    });
  });

  it('refuses a configured pipeline belonging to another account', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    const result = await createDeal.run(
      { title: 'CRM build' },
      ctxWith(prisma, { dealConfig: { deal_pipeline_id: 'pipe-other-tenant' } }),
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
        dealConfig: {
          deal_pipeline_id: 'pipe-old',
          // Belongs to pipe-new — stale config after a pipeline was rebuilt.
          deal_stage_id: 'stage-new-1',
        },
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
    const fx = standardFixture();
    fx.pipelines = [];
    fx.stages = [];
    const { prisma, created } = fakePrisma(fx);

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

  it('records the conversation it came from', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    await createDeal.run(
      { title: 'CRM build' },
      ctxWith(prisma, { conversationId: 'conv-fresh' }),
    );

    // Provenance, and the key the duplicate guard reads next time.
    expect(created[0]).toMatchObject({ conversation_id: 'conv-fresh' });
  });
});

/**
 * One deal per conversation. Two messages in one thread produced "CRM and
 * HRMS Tool Project" and "CRM and HRMS Software" for the same customer at
 * the same value — neither title nor value marks them as duplicates, only
 * the thread does.
 */
describe('create_deal duplicate guard', () => {
  it('creates no second deal when nothing changed', async () => {
    const { prisma, created, updated } = fakePrisma(standardFixture());

    // Same value the deal already carries, no new notes.
    const result = await createDeal.run(
      { title: 'CRM and HRMS Software', value: 50000 },
      ctxWith(prisma, { conversationId: 'conv-taken' }),
    );

    // Reported as SUCCESS with the existing id: the model should carry on
    // as though it had created one, not retry or apologise.
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('deal-latest');
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('UPDATES the value when the customer changes their budget', async () => {
    const { prisma, created, updated } = fakePrisma(standardFixture());

    // "i have to update my requirement, my budget is 40k" — the deal on
    // this thread is 50000.
    const result = await createDeal.run(
      { title: 'CRM and HRMS Project', value: 40000 },
      ctxWith(prisma, { conversationId: 'conv-taken' }),
    );

    // Refusing here is what made the bot answer "Got it, I've noted the
    // updated budget of 40k" while the CRM still said 50k.
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(0);
    expect(updated).toEqual([{ id: 'deal-latest', data: { value: 40000 } }]);
    expect(result.detail).toMatch(/40000/);
  });

  it('appends notes rather than replacing the earlier requirement', async () => {
    const { prisma, updated } = fakePrisma(standardFixture());

    await createDeal.run(
      { title: 'CRM build', notes: 'Also needs HRMS' },
      ctxWith(prisma, { conversationId: 'conv-taken' }),
    );

    const notes = updated[0].data.notes as string;
    expect(notes).toContain('Wants it in 1 month'); // the original
    expect(notes).toContain('Also needs HRMS'); // the update
  });

  it('never renames the deal, moves its stage, or reassigns it', async () => {
    const { prisma, updated } = fakePrisma(standardFixture());

    await createDeal.run(
      { title: 'A completely different wording', value: 40000 },
      ctxWith(prisma, { conversationId: 'conv-taken' }),
    );

    // A human reads the title in the pipeline and may have moved the deal
    // along; restating a budget is not a reason to undo either.
    const patched = Object.keys(updated[0].data);
    expect(patched).toEqual(['value']);
  });

  it('allows a new deal on a different thread for the same customer', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    // contact-1 already has open deals on conv-old and conv-taken. A
    // website enquiry and a wedding order are not duplicates.
    const result = await createDeal.run(
      { title: 'Website revamp', value: 25000 },
      ctxWith(prisma, { contactId: 'contact-1', conversationId: 'conv-brand-new' }),
    );

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ conversation_id: 'conv-brand-new' });
  });

  it('allows a new deal once the thread\'s earlier deal is closed', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    // conv-closed's deal is 'won', so the thread is free to earn another.
    const result = await createDeal.run(
      { title: 'Follow-up job' },
      ctxWith(prisma, { conversationId: 'conv-closed' }),
    );

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('never dedupes against another account\'s conversation', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    // conv-theirs has an open deal, but on acc-2.
    const result = await createDeal.run(
      { title: 'CRM build' },
      ctxWith(prisma, { conversationId: 'conv-theirs' }),
    );

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('creates without a guard in the playground, where there is no thread', async () => {
    const { prisma, created } = fakePrisma(standardFixture());

    const result = await createDeal.run(
      { title: 'Test deal' },
      ctxWith(prisma, { contactId: null, conversationId: null }),
    );

    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({
      conversation_id: null,
      contact_id: null,
    });
  });
});

describe('assign_deal', () => {
  it('assigns by first name to the profile id', async () => {
    const { prisma, updated } = fakePrisma(standardFixture());

    const result = await assignDeal.run({ assignee: 'Priya' }, ctxWith(prisma));

    expect(result.ok).toBe(true);
    expect(updated).toEqual([
      { id: 'deal-latest', data: { assigned_to: 'profile-priya' } },
    ]);
  });

  it("defaults to the customer's NEWEST open deal", async () => {
    const { prisma, updated } = fakePrisma(standardFixture());

    await assignDeal.run({ assignee: 'priya@acme.test' }, ctxWith(prisma));

    // deal-old is also open for this contact; recency decides.
    expect(updated[0].id).toBe('deal-latest');
  });

  it('never matches a teammate from another account', async () => {
    const { prisma, updated } = fakePrisma(standardFixture());

    // 'Priya Sharma' / priya@other.test lives on acc-2. The pre-fix
    // lookup had no account filter at all.
    const result = await assignDeal.run(
      { assignee: 'priya@other.test' },
      ctxWith(prisma),
    );

    expect(result.ok).toBe(false);
    expect(updated).toHaveLength(0);
  });

  it('refuses another account\'s deal id', async () => {
    const { prisma, updated } = fakePrisma(standardFixture());

    const result = await assignDeal.run(
      { assignee: 'Priya', deal_id: 'deal-other-tenant' },
      ctxWith(prisma),
    );

    expect(result.ok).toBe(false);
    expect(updated).toHaveLength(0);
  });

  it('refuses an ambiguous name instead of guessing', async () => {
    const fx = standardFixture();
    fx.profiles.push({
      id: 'profile-priya-2',
      userId: 'user-priya-2',
      accountId: ACCOUNT,
      fullName: 'Priya Menon',
      email: 'priya.menon@acme.test',
    });
    const { prisma, updated } = fakePrisma(fx);

    const result = await assignDeal.run({ assignee: 'Priya' }, ctxWith(prisma));

    // Two Priyas on one team: putting the deal on the wrong desk silently
    // is worse than asking which one.
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/more than one/i);
    expect(updated).toHaveLength(0);
  });

  it('picks the exact full-name match when a fuzzy one also exists', async () => {
    const fx = standardFixture();
    fx.profiles.push({
      id: 'profile-priya-2',
      userId: 'user-priya-2',
      accountId: ACCOUNT,
      fullName: 'Priya Nair Menon',
      email: 'pnm@acme.test',
    });
    const { prisma, updated } = fakePrisma(fx);

    const result = await assignDeal.run(
      { assignee: 'Priya Nair' },
      ctxWith(prisma),
    );

    expect(result.ok).toBe(true);
    expect(updated[0].data).toEqual({ assigned_to: 'profile-priya' });
  });

  it('says there is nothing to assign when the customer has no open deal', async () => {
    const fx = standardFixture();
    fx.deals = fx.deals.filter((d) => d.account_id !== ACCOUNT);
    const { prisma, updated } = fakePrisma(fx);

    const result = await assignDeal.run({ assignee: 'Priya' }, ctxWith(prisma));

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no open deal/i);
    expect(updated).toHaveLength(0);
  });

  it('requires a name', async () => {
    const { prisma, updated } = fakePrisma(standardFixture());

    const result = await assignDeal.run({}, ctxWith(prisma));

    expect(result.ok).toBe(false);
    expect(updated).toHaveLength(0);
  });
});
