import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SegmentMembershipService } from './segment-membership.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * What these tests are protecting.
 *
 * Five surfaces file contacts into segments — the automation step, the
 * flow node, CSV import, the public API and the broadcast resolver — and
 * every one of them receives its contact id from somewhere the account
 * does not control. Prisma connects as the database owner so RLS is not
 * protecting any of them; the account check has to be here, and the
 * tests that say so have to be here too.
 *
 * The SQL side (`add_contacts_to_segment` refusing a foreign contact, a
 * dynamic segment, or a duplicate) is verified against a real database
 * rather than mocked here — a mock cannot tell you what Postgres does.
 * These cover the half that lives in TypeScript.
 */

function makePrismaMock() {
  return {
    contact_segments: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'seg-1',
        name: 'VIPs',
        kind: 'static',
      }),
    },
    contact_segment_members: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ added: 2 }]),
  };
}

describe('SegmentMembershipService.findForAccount', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: SegmentMembershipService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new SegmentMembershipService(prisma as unknown as PrismaService);
  });

  it('scopes the lookup to the calling account', async () => {
    await service.findForAccount('acc-1', 'seg-1');
    expect(prisma.contact_segments.findFirst).toHaveBeenCalledWith({
      where: { id: 'seg-1', account_id: 'acc-1' },
      select: { id: true, name: true, kind: true },
    });
  });

  it('returns null for a segment belonging to another workspace', async () => {
    prisma.contact_segments.findFirst.mockResolvedValue(null);
    expect(await service.findForAccount('acc-1', 'seg-of-acc-2')).toBeNull();
  });

  it('returns null for an empty segment id without querying', async () => {
    expect(await service.findForAccount('acc-1', '')).toBeNull();
    expect(prisma.contact_segments.findFirst).not.toHaveBeenCalled();
  });

  it('normalises an unrecognised kind to static rather than passing it through', async () => {
    // The CHECK constraint makes this unreachable today, but the caller
    // branches on `kind !== 'static'` to decide whether a write is
    // allowed — so an unknown value must land on the restrictive side of
    // that branch by construction, not by luck.
    prisma.contact_segments.findFirst.mockResolvedValue({
      id: 'seg-1',
      name: 'Odd',
      kind: 'something-else',
    });
    const segment = await service.findForAccount('acc-1', 'seg-1');
    expect(segment?.kind).toBe('static');
  });
});

describe('SegmentMembershipService.add / remove', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: SegmentMembershipService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new SegmentMembershipService(prisma as unknown as PrismaService);
  });

  it('does not hit the database for an empty id list', async () => {
    expect(await service.add('seg-1', [], 'automation')).toBe(0);
    expect(await service.remove('seg-1', [])).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('drops nulls and duplicates before building the uuid[]', async () => {
    // Postgres rejects a NULL inside uuid[], and a repeated id turns a
    // set-based insert into a self-conflict. A CSV and a webhook payload
    // can both produce either.
    const ids = [
      'c-1',
      'c-1',
      null,
      undefined,
      '',
      'c-2',
    ] as unknown as string[];
    await service.add('seg-1', ids, 'import');

    const params = prisma.$queryRaw.mock.calls[0].slice(1);
    expect(params).toContainEqual(['c-1', 'c-2']);
  });

  it('reports rows actually written, so "already a member" is distinguishable', async () => {
    prisma.$queryRaw.mockResolvedValue([{ added: 0 }]);
    expect(await service.add('seg-1', ['c-1'], 'manual')).toBe(0);
  });

  it('coerces a bigint-ish count to a number', async () => {
    // The SQL function returns INTEGER, but the driver has handed back
    // strings for numeric types before; Number() here keeps the public
    // signature honest.
    prisma.$queryRaw.mockResolvedValue([{ added: '3' }]);
    expect(await service.add('seg-1', ['c-1'], 'manual')).toBe(3);
  });

  it('returns 0 rather than NaN when the function returns nothing', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    expect(await service.add('seg-1', ['c-1'], 'manual')).toBe(0);
  });
});

describe('SegmentMembershipService.resolve', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: SegmentMembershipService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new SegmentMembershipService(prisma as unknown as PrismaService);
  });

  it('refuses to resolve a segment from another workspace', async () => {
    prisma.contact_segments.findFirst.mockResolvedValue(null);
    expect(await service.resolve('acc-1', 'seg-of-acc-2')).toEqual([]);
    // The important half: it never even asked the database for members.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('resolves through the RPC, not through the members table', async () => {
    // A dynamic segment has no rows in contact_segment_members. Reading
    // that table directly looks like it works and silently returns an
    // empty audience — which is why nothing may do it.
    prisma.$queryRaw.mockResolvedValue([
      { contact_id: 'c-1' },
      { contact_id: 'c-2' },
    ]);
    expect(await service.resolve('acc-1', 'seg-1')).toEqual(['c-1', 'c-2']);
    expect(prisma.contact_segment_members.findMany).not.toHaveBeenCalled();
  });

  it('unions several segments and de-duplicates the overlap', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ contact_id: 'c-1' }, { contact_id: 'c-2' }])
      .mockResolvedValueOnce([{ contact_id: 'c-2' }, { contact_id: 'c-3' }]);
    const ids = await service.resolveMany('acc-1', ['seg-1', 'seg-2']);
    expect(ids.sort()).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('de-duplicates the segment list itself before resolving', async () => {
    await service.resolveMany('acc-1', ['seg-1', 'seg-1']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for an empty segment list without querying', async () => {
    expect(await service.resolveMany('acc-1', [])).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('SegmentMembershipService.segmentsForContact', () => {
  it('constrains the join to the calling account', async () => {
    const prisma = makePrismaMock();
    const service = new SegmentMembershipService(
      prisma as unknown as PrismaService,
    );
    await service.segmentsForContact('acc-1', 'c-1');
    expect(prisma.contact_segment_members.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contact_id: 'c-1',
          segment: { account_id: 'acc-1' },
        },
      }),
    );
  });
});
