import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../ig-api.util', () => ({
  getUserProfile: vi.fn(),
  sendPrivateReply: vi.fn(),
  replyToComment: vi.fn(),
}));

import {
  CommentFunnelService,
  matchesKeywords,
  parsePayload,
  parseRewardButtons,
  pickPublicReply,
} from './comment-funnel.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { InstagramConnectService } from './instagram-connect.service';
import type { InstagramSendService } from './instagram-send.service';
import {
  getUserProfile,
  replyToComment,
  sendPrivateReply,
} from '../ig-api.util';

const ACCOUNT = 'acc-1';
const OWNER = 'user-1';
const IGSID = '99887766';
const COMMENT_ROW = 'cmt-row-1';
const IG_COMMENT_ID = 'ig-cmt-1';
const MEDIA_ID = 'media-1';
const RUN_ID = 'run-1';

function makeFunnel(over: Record<string, unknown> = {}) {
  return {
    id: 'funnel-1',
    account_id: ACCOUNT,
    ig_media_id: null,
    keywords: [],
    optin_text: 'Tap below ✨',
    optin_button_label: "I'm ready 🙂",
    follow_gate_enabled: true,
    follow_ask_text: "You aren't following!",
    follow_button_label: 'I followed you! ✅',
    reward_text: 'Here you go 🎁',
    reward_buttons: [{ label: 'Click here!', url: 'https://example.com' }],
    public_reply_texts: [],
    reply_delay_seconds: 0,
    matched_count: 0,
    is_active: true,
    ...over,
  };
}

function makePrisma(
  opts: {
    enabled?: boolean;
    status?: string;
    funnels?: Array<Record<string, unknown>>;
    privateRepliedAt?: Date | null;
    run?: Record<string, unknown> | null;
    createThrows?: { code?: string };
  } = {},
) {
  const funnelUpdates: Array<Record<string, unknown>> = [];
  const runUpdates: Array<Record<string, unknown>> = [];
  const commentUpdates: Array<Record<string, unknown>> = [];
  const runCreates: Array<Record<string, unknown>> = [];

  const prisma = {
    instagram_config: {
      findUnique: vi.fn(() =>
        Promise.resolve({
          comment_funnels_enabled: opts.enabled ?? true,
          status: opts.status ?? 'connected',
        }),
      ),
    },
    instagram_comments: {
      findUnique: vi.fn(() =>
        Promise.resolve({ private_replied_at: opts.privateRepliedAt ?? null }),
      ),
      update: vi.fn(({ data }: never) => {
        commentUpdates.push(data as Record<string, unknown>);
        return Promise.resolve({});
      }),
    },
    instagram_comment_funnels: {
      findMany: vi.fn(() => Promise.resolve(opts.funnels ?? [makeFunnel()])),
      update: vi.fn(({ data }: never) => {
        funnelUpdates.push(data as Record<string, unknown>);
        return Promise.resolve({});
      }),
    },
    instagram_comment_funnel_runs: {
      create: vi.fn(({ data }: never) => {
        runCreates.push(data as Record<string, unknown>);
        return opts.createThrows
          ? Promise.reject(Object.assign(new Error('dup'), opts.createThrows))
          : Promise.resolve({ id: RUN_ID });
      }),
      findFirst: vi.fn(() => Promise.resolve(opts.run ?? null)),
      update: vi.fn(({ data }: never) => {
        runUpdates.push(data as Record<string, unknown>);
        return Promise.resolve({});
      }),
    },
  };

  return { prisma, funnelUpdates, runUpdates, commentUpdates, runCreates };
}

function makeSend() {
  return {
    sendText: vi.fn().mockResolvedValue({ messageId: 'm1', internalId: 'i1' }),
    sendButtons: vi
      .fn()
      .mockResolvedValue({ messageId: 'm2', internalId: 'i2' }),
    sendLinkButtons: vi
      .fn()
      .mockResolvedValue({ messageId: 'm3', internalId: 'i3' }),
  };
}

function makeConnect(
  config: unknown = { igUserId: 'ig-biz', accessToken: 'tok', userId: OWNER },
) {
  return { loadUsableConfig: vi.fn(() => Promise.resolve(config)) };
}

function makeQueue(addThrows = false) {
  // Typed on the mock rather than the implementation: a bare
  // `vi.fn(() => …)` infers a zero-arity signature, so the assertions
  // could not read `calls[0][1]` — and naming the parameters just to
  // widen it trips no-unused-vars.
  const add: Mock<
    (name: string, data: unknown, opts?: unknown) => Promise<{ id: string }>
  > = vi.fn();
  add.mockImplementation(() =>
    addThrows
      ? Promise.reject(new Error('redis down'))
      : Promise.resolve({ id: 'job-1' }),
  );
  return { add };
}

function build(
  prisma: unknown,
  send: unknown,
  extra: { connect?: unknown; queue?: unknown } = {},
) {
  return new CommentFunnelService(
    prisma as PrismaService,
    send as InstagramSendService,
    (extra.connect ?? makeConnect()) as InstagramConnectService,
    // The queue is only reached by funnels with a reply delay; the
    // default double throws loudly if an undelayed test touches it.
    (extra.queue ?? makeQueue()) as never,
  );
}

const commentArgs = (text = 'send me the link') => ({
  accountId: ACCOUNT,
  ownerUserId: OWNER,
  igUserId: 'ig-biz',
  accessToken: 'tok',
  commentRowId: COMMENT_ROW,
  igCommentId: IG_COMMENT_ID,
  igMediaId: MEDIA_ID,
  fromIgsid: IGSID,
  text,
});

const postbackArgs = (payload: string) => ({
  accountId: ACCOUNT,
  ownerUserId: OWNER,
  accessToken: 'tok',
  contactId: 'contact-1',
  conversationId: 'conv-1',
  fromIgsid: IGSID,
  payload,
});

beforeEach(() => {
  vi.mocked(sendPrivateReply)
    .mockReset()
    .mockResolvedValue({
      messageId: 'pm-1',
    } as never);
  vi.mocked(replyToComment).mockReset().mockResolvedValue({ id: 'r1' });
  vi.mocked(getUserProfile).mockReset();
});

// ============================================================
// Pure helpers
// ============================================================

describe('parsePayload', () => {
  it('accepts the two funnel steps', () => {
    expect(parsePayload('c2dm:abc:optin')).toEqual({
      runId: 'abc',
      step: 'optin',
    });
    expect(parsePayload('c2dm:abc:followed')).toEqual({
      runId: 'abc',
      step: 'followed',
    });
  });

  it('ignores payloads belonging to other engines', () => {
    // Flows, automations and ice-breakers share this webhook. Claiming
    // one of their taps would silently break them.
    expect(parsePayload('flow:node-3')).toBeNull();
    expect(parsePayload('')).toBeNull();
    expect(parsePayload('c2dm:abc')).toBeNull();
    expect(parsePayload('c2dm:abc:delivered')).toBeNull();
  });
});

describe('matchesKeywords', () => {
  it('matches everything when no keywords are set', () => {
    expect(matchesKeywords([], 'anything at all')).toBe(true);
  });

  it('matches case-insensitively as a substring', () => {
    expect(matchesKeywords(['LINK'], 'send me the link please')).toBe(true);
    expect(matchesKeywords(['link'], 'nothing relevant')).toBe(false);
  });
});

describe('parseRewardButtons', () => {
  it('drops entries that are not http(s) links', () => {
    // These end up in a button Meta renders publicly.
    const out = parseRewardButtons([
      { label: 'ok', url: 'https://example.com' },
      { label: 'bad', url: 'javascript:alert(1)' },
      { label: '', url: 'https://example.com' },
      'nonsense',
    ]);
    expect(out).toEqual([{ label: 'ok', url: 'https://example.com' }]);
  });

  it('caps at the 3 Meta will render', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      label: `b${i}`,
      url: 'https://example.com',
    }));
    expect(parseRewardButtons(many)).toHaveLength(3);
  });

  it('survives a non-array', () => {
    expect(parseRewardButtons(null)).toEqual([]);
    expect(parseRewardButtons({ label: 'x' })).toEqual([]);
  });
});

describe('pickPublicReply', () => {
  const variants = ['Sent ✅', 'Check DM 📩', 'DMed you!'];

  it('round-robins through the variants', () => {
    expect(variants.map((_, i) => pickPublicReply(variants, i))).toEqual(
      variants,
    );
    // And wraps, rather than falling off the end.
    expect(pickPublicReply(variants, 3)).toBe('Sent ✅');
    expect(pickPublicReply(variants, 7)).toBe('Check DM 📩');
  });

  it('means "private only" when there is nothing to post', () => {
    expect(pickPublicReply([], 0)).toBeNull();
    expect(pickPublicReply(null, 0)).toBeNull();
    expect(pickPublicReply(undefined, 4)).toBeNull();
  });

  it('skips blanks rather than posting one', () => {
    // A blank entry must not become a turn where nothing is said.
    expect(pickPublicReply(['', '  ', 'Check DM 📩'], 0)).toBe('Check DM 📩');
    expect(pickPublicReply(['', '  '], 2)).toBeNull();
  });

  it('cannot index off the front of the list', () => {
    expect(pickPublicReply(variants, -1)).toBe('Sent ✅');
    expect(pickPublicReply(variants, Number.NaN)).toBe('Sent ✅');
  });
});

// ============================================================
// onComment
// ============================================================

describe('CommentFunnelService — a comment arrives', () => {
  it('private-replies with a button and claims the comment', async () => {
    const { prisma, commentUpdates, funnelUpdates } = makePrisma();
    const claimed = await build(prisma, makeSend()).onComment(commentArgs());

    expect(claimed).toBe(true);
    expect(vi.mocked(sendPrivateReply)).toHaveBeenCalledTimes(1);

    const sent = vi.mocked(sendPrivateReply).mock.calls[0][0];
    expect(sent.commentId).toBe(IG_COMMENT_ID);
    // The button is the whole point: without an inbound event, Meta
    // will not answer is_user_follow_business for this person.
    expect(sent.quickReplies).toEqual([
      { title: "I'm ready 🙂", payload: `c2dm:${RUN_ID}:optin` },
    ]);

    expect(commentUpdates[0].private_replied_at).toBeInstanceOf(Date);
    expect(funnelUpdates[0]).toEqual({ matched_count: { increment: 1 } });
  });

  it('does nothing while the account master switch is off', async () => {
    // The switch has to beat every funnel's own is_active, or "pause
    // everything" is not a thing the merchant can actually do.
    const { prisma } = makePrisma({ enabled: false });
    const claimed = await build(prisma, makeSend()).onComment(commentArgs());

    expect(claimed).toBe(false);
    expect(vi.mocked(sendPrivateReply)).not.toHaveBeenCalled();
  });

  it('does not claim a comment no funnel wants', async () => {
    const { prisma } = makePrisma({
      funnels: [makeFunnel({ keywords: ['discount'] })],
    });
    const claimed = await build(prisma, makeSend()).onComment(
      commentArgs('lovely photo'),
    );

    expect(claimed).toBe(false);
    expect(vi.mocked(sendPrivateReply)).not.toHaveBeenCalled();
  });

  it('respects Meta’s one-private-reply-per-comment budget', async () => {
    const { prisma } = makePrisma({ privateRepliedAt: new Date() });
    const claimed = await build(prisma, makeSend()).onComment(commentArgs());

    expect(claimed).toBe(false);
    expect(vi.mocked(sendPrivateReply)).not.toHaveBeenCalled();
  });

  it('sends one DM to someone who comments repeatedly', async () => {
    // The unique index doing its job. Still "claimed", so the older
    // automation trigger cannot answer the second comment either.
    const { prisma } = makePrisma({ createThrows: { code: 'P2002' } });
    const claimed = await build(prisma, makeSend()).onComment(commentArgs());

    expect(claimed).toBe(true);
    expect(vi.mocked(sendPrivateReply)).not.toHaveBeenCalled();
  });

  it('posts the public reply when one is configured', async () => {
    const { prisma } = makePrisma({
      funnels: [makeFunnel({ public_reply_texts: ['Check your DMs 📩'] })],
    });
    await build(prisma, makeSend()).onComment(commentArgs());

    expect(vi.mocked(replyToComment)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Check your DMs 📩' }),
    );
  });

  it('rotates the public reply on the funnel’s match count', async () => {
    // Two funnels differing only in how many times they have already
    // matched: the third variant is what the third match must post.
    const { prisma } = makePrisma({
      funnels: [
        makeFunnel({
          matched_count: 2,
          public_reply_texts: ['Sent ✅', 'Check DM 📩', 'DMed you!'],
        }),
      ],
    });
    await build(prisma, makeSend()).onComment(commentArgs());

    expect(vi.mocked(replyToComment)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'DMed you!' }),
    );
  });

  it('keeps the DM when the public reply fails', async () => {
    // The private reply is already spent by then; a failed public
    // comment must not roll it back.
    vi.mocked(replyToComment).mockRejectedValue(new Error('rate limited'));
    const { prisma, commentUpdates } = makePrisma({
      funnels: [makeFunnel({ public_reply_texts: ['Check your DMs 📩'] })],
    });

    const claimed = await build(prisma, makeSend()).onComment(commentArgs());

    expect(claimed).toBe(true);
    expect(commentUpdates[0].private_replied_at).toBeInstanceOf(Date);
  });

  it('parks a failed private reply on the run instead of throwing', async () => {
    // The caller is a webhook that already answered Meta, so throwing
    // would make the failure invisible.
    vi.mocked(sendPrivateReply).mockRejectedValue(new Error('comment gone'));
    const { prisma, runUpdates } = makePrisma();

    const claimed = await build(prisma, makeSend()).onComment(commentArgs());

    expect(claimed).toBe(true);
    expect(runUpdates[0]).toMatchObject({
      state: 'failed',
      last_error: 'comment gone',
    });
  });
});

// ============================================================
// Precedence when two funnels cover the same post
// ============================================================

describe('CommentFunnelService — two funnels cover one post', () => {
  it('asks the database for post-scoped funnels FIRST', async () => {
    // The precedence rule lives in an ORDER BY, so this asserts the query
    // rather than the result — the other tests in this file stub findMany
    // and would happily pass with the ordering inverted.
    //
    // nulls:'last' is the whole point: ig_media_id is NULL for the
    // account-wide funnel and Postgres sorts NULLS FIRST on DESC, so a
    // plain 'desc' silently puts the catch-all in front.
    const { prisma } = makePrisma();
    await build(prisma, makeSend()).onComment(commentArgs());

    expect(prisma.instagram_comment_funnels.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { ig_media_id: { sort: 'desc', nulls: 'last' } },
          { created_at: 'asc' },
        ],
      }),
    );
  });

  it('runs the post’s own funnel, not the catch-all', async () => {
    // Candidates arrive in the DB's order; the post-scoped one is first.
    const own = makeFunnel({ id: 'own', ig_media_id: MEDIA_ID, keywords: [] });
    const global = makeFunnel({
      id: 'global',
      ig_media_id: null,
      keywords: ['price'],
    });
    const { prisma, funnelUpdates, runCreates } = makePrisma({
      funnels: [own, global],
    });

    await build(prisma, makeSend()).onComment(commentArgs('price please'));

    // Both would match "price please" — the post's own funnel takes it.
    expect(runCreates).toHaveLength(1);
    expect(runCreates[0].funnel_id).toBe('own');
    // And only one funnel is credited, so only one DM went out.
    expect(funnelUpdates).toHaveLength(1);
  });

  it('falls back to the catch-all when the post’s funnel does not match', async () => {
    const own = makeFunnel({
      id: 'own',
      ig_media_id: MEDIA_ID,
      keywords: ['link'],
    });
    const global = makeFunnel({
      id: 'global',
      ig_media_id: null,
      keywords: ['price'],
    });
    const { prisma, runCreates } = makePrisma({ funnels: [own, global] });

    await build(prisma, makeSend()).onComment(commentArgs('price please'));

    expect(runCreates).toHaveLength(1);
    expect(runCreates[0].funnel_id).toBe('global');
  });

  it('answers a comment once when neither funnel has keywords', async () => {
    // The worst conflict: two catch-alls over the same post. One wins,
    // one private reply is spent, nobody gets two DMs.
    const own = makeFunnel({ id: 'own', ig_media_id: MEDIA_ID, keywords: [] });
    const global = makeFunnel({
      id: 'global',
      ig_media_id: null,
      keywords: [],
    });
    const { prisma, runCreates } = makePrisma({ funnels: [own, global] });

    await build(prisma, makeSend()).onComment(commentArgs('anything'));

    expect(vi.mocked(sendPrivateReply)).toHaveBeenCalledTimes(1);
    expect(runCreates).toHaveLength(1);
  });
});

// ============================================================
// The reply delay
// ============================================================

describe('CommentFunnelService — a delayed funnel', () => {
  it('parks the DM on the queue instead of sending it', async () => {
    const { prisma } = makePrisma({
      funnels: [makeFunnel({ reply_delay_seconds: 30 })],
    });
    const queue = makeQueue();

    const claimed = await build(prisma, makeSend(), { queue }).onComment(
      commentArgs(),
    );

    // Claimed, so the older automation cannot answer the same comment
    // during the wait — but nothing has been sent yet.
    expect(claimed).toBe(true);
    expect(vi.mocked(sendPrivateReply)).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'optin',
      expect.objectContaining({ runId: RUN_ID, accountId: ACCOUNT }),
      expect.objectContaining({ delay: 30_000, jobId: `optin:${RUN_ID}` }),
    );
  });

  it('never puts the access token in the job payload', async () => {
    // The job sits in Redis for up to an hour. A decrypted long-lived
    // token in that payload is a credential nobody is auditing.
    const { prisma } = makePrisma({
      funnels: [makeFunnel({ reply_delay_seconds: 60 })],
    });
    const queue = makeQueue();

    await build(prisma, makeSend(), { queue }).onComment(commentArgs());

    expect(JSON.stringify(queue.add.mock.calls[0][1])).not.toContain('tok');
  });

  it('sends immediately when the queue is unreachable', async () => {
    // A dropped job means someone commented, was claimed, and never
    // heard back. Sooner than configured beats never.
    const { prisma } = makePrisma({
      funnels: [makeFunnel({ reply_delay_seconds: 30 })],
    });

    const claimed = await build(prisma, makeSend(), {
      queue: makeQueue(true),
    }).onComment(commentArgs());

    expect(claimed).toBe(true);
    expect(vi.mocked(sendPrivateReply)).toHaveBeenCalledTimes(1);
  });

  it('sends the parked DM when the delay elapses', async () => {
    const { prisma, commentUpdates } = makePrisma({
      run: { id: RUN_ID, state: 'awaiting_optin', funnel: makeFunnel() },
    });

    await build(prisma, makeSend()).runDelayedOptin({
      runId: RUN_ID,
      accountId: ACCOUNT,
      commentRowId: COMMENT_ROW,
      igCommentId: IG_COMMENT_ID,
    });

    expect(vi.mocked(sendPrivateReply)).toHaveBeenCalledTimes(1);
    expect(commentUpdates[0].private_replied_at).toBeInstanceOf(Date);
  });

  it('does not send when the funnel was paused during the wait', async () => {
    const { prisma, runUpdates } = makePrisma({
      run: {
        id: RUN_ID,
        state: 'awaiting_optin',
        funnel: makeFunnel({ is_active: false }),
      },
    });

    await build(prisma, makeSend()).runDelayedOptin({
      runId: RUN_ID,
      accountId: ACCOUNT,
      commentRowId: COMMENT_ROW,
      igCommentId: IG_COMMENT_ID,
    });

    expect(vi.mocked(sendPrivateReply)).not.toHaveBeenCalled();
    expect(runUpdates[0]).toMatchObject({ state: 'failed' });
  });

  it('does not spend a private reply an agent already used', async () => {
    const { prisma, runUpdates } = makePrisma({
      privateRepliedAt: new Date(),
      run: { id: RUN_ID, state: 'awaiting_optin', funnel: makeFunnel() },
    });

    await build(prisma, makeSend()).runDelayedOptin({
      runId: RUN_ID,
      accountId: ACCOUNT,
      commentRowId: COMMENT_ROW,
      igCommentId: IG_COMMENT_ID,
    });

    expect(vi.mocked(sendPrivateReply)).not.toHaveBeenCalled();
    expect(runUpdates[0]).toMatchObject({ state: 'failed' });
  });

  it('is silent about a run that already advanced', async () => {
    // A tap can beat the delay. Not a fault, and not worth a failed row.
    const { prisma, runUpdates } = makePrisma({
      run: { id: RUN_ID, state: 'delivered', funnel: makeFunnel() },
    });

    await build(prisma, makeSend()).runDelayedOptin({
      runId: RUN_ID,
      accountId: ACCOUNT,
      commentRowId: COMMENT_ROW,
      igCommentId: IG_COMMENT_ID,
    });

    expect(vi.mocked(sendPrivateReply)).not.toHaveBeenCalled();
    expect(runUpdates).toHaveLength(0);
  });

  it('parks a run whose connection died during the wait', async () => {
    const { prisma, runUpdates } = makePrisma({
      run: { id: RUN_ID, state: 'awaiting_optin', funnel: makeFunnel() },
    });

    await build(prisma, makeSend(), {
      connect: makeConnect(null),
    }).runDelayedOptin({
      runId: RUN_ID,
      accountId: ACCOUNT,
      commentRowId: COMMENT_ROW,
      igCommentId: IG_COMMENT_ID,
    });

    expect(vi.mocked(sendPrivateReply)).not.toHaveBeenCalled();
    expect(runUpdates[0]).toMatchObject({ state: 'failed' });
  });
});

// ============================================================
// onPostback
// ============================================================

describe('CommentFunnelService — the opt-in tap', () => {
  it('asks a non-follower to follow', async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      igsid: IGSID,
      isUserFollowBusiness: false,
    });
    const { prisma, runUpdates } = makePrisma({
      run: { id: RUN_ID, state: 'awaiting_optin', funnel: makeFunnel() },
    });
    const send = makeSend();

    const consumed = await build(prisma, send).onPostback(
      postbackArgs(`c2dm:${RUN_ID}:optin`),
    );

    expect(consumed).toBe(true);
    expect(send.sendButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "You aren't following!",
        buttons: [
          { id: `c2dm:${RUN_ID}:followed`, title: 'I followed you! ✅' },
        ],
      }),
    );
    expect(send.sendLinkButtons).not.toHaveBeenCalled();
    expect(runUpdates.at(-1)).toMatchObject({ state: 'awaiting_follow' });
  });

  it('skips the gate for someone already following', async () => {
    // Telling an existing follower to follow is the fastest way to make
    // the funnel feel broken.
    vi.mocked(getUserProfile).mockResolvedValue({
      igsid: IGSID,
      isUserFollowBusiness: true,
    });
    const { prisma } = makePrisma({
      run: { id: RUN_ID, state: 'awaiting_optin', funnel: makeFunnel() },
    });
    const send = makeSend();

    await build(prisma, send).onPostback(postbackArgs(`c2dm:${RUN_ID}:optin`));

    expect(send.sendButtons).not.toHaveBeenCalled();
    expect(send.sendLinkButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Here you go 🎁',
        buttons: [{ label: 'Click here!', url: 'https://example.com' }],
      }),
    );
  });

  it('delivers when the follow lookup fails', async () => {
    // Fails OPEN. Under a soft gate the reward ships regardless, so
    // withholding it because of an outage on our side is strictly worse
    // than not checking at all.
    vi.mocked(getUserProfile).mockRejectedValue(new Error('403'));
    const { prisma, runUpdates } = makePrisma({
      run: { id: RUN_ID, state: 'awaiting_optin', funnel: makeFunnel() },
    });
    const send = makeSend();

    await build(prisma, send).onPostback(postbackArgs(`c2dm:${RUN_ID}:optin`));

    expect(send.sendLinkButtons).toHaveBeenCalled();
    // Recorded as unknown, not as a false — was_following is reporting,
    // and a fallback must not read as an observation.
    expect(
      runUpdates.find((u) => 'was_following' in u)?.was_following,
    ).toBeNull();
  });

  it('goes straight to the reward when the gate is off', async () => {
    const { prisma } = makePrisma({
      run: {
        id: RUN_ID,
        state: 'awaiting_optin',
        funnel: makeFunnel({ follow_gate_enabled: false }),
      },
    });
    const send = makeSend();

    await build(prisma, send).onPostback(postbackArgs(`c2dm:${RUN_ID}:optin`));

    expect(vi.mocked(getUserProfile)).not.toHaveBeenCalled();
    expect(send.sendLinkButtons).toHaveBeenCalled();
  });

  it('sends plain text when the funnel has no reward buttons', async () => {
    const { prisma } = makePrisma({
      run: {
        id: RUN_ID,
        state: 'awaiting_optin',
        funnel: makeFunnel({ follow_gate_enabled: false, reward_buttons: [] }),
      },
    });
    const send = makeSend();

    await build(prisma, send).onPostback(postbackArgs(`c2dm:${RUN_ID}:optin`));

    expect(send.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Here you go 🎁' }),
    );
    expect(send.sendLinkButtons).not.toHaveBeenCalled();
  });
});

describe('CommentFunnelService — the follow tap', () => {
  it('delivers without re-checking', async () => {
    // Soft gate. A second lookup could only produce a false negative —
    // follow status lags by seconds — and cost a conversion the gate
    // was never meant to block.
    const { prisma, runUpdates } = makePrisma({
      run: { id: RUN_ID, state: 'awaiting_follow', funnel: makeFunnel() },
    });
    const send = makeSend();

    const consumed = await build(prisma, send).onPostback(
      postbackArgs(`c2dm:${RUN_ID}:followed`),
    );

    expect(consumed).toBe(true);
    expect(vi.mocked(getUserProfile)).not.toHaveBeenCalled();
    expect(send.sendLinkButtons).toHaveBeenCalled();
    expect(runUpdates.at(-1)).toMatchObject({ state: 'delivered' });
  });

  it('will not deliver the reward twice', async () => {
    const { prisma } = makePrisma({
      run: { id: RUN_ID, state: 'delivered', funnel: makeFunnel() },
    });
    const send = makeSend();

    const consumed = await build(prisma, send).onPostback(
      postbackArgs(`c2dm:${RUN_ID}:followed`),
    );

    // Still consumed: a duplicate tap is ours to swallow, not the AI
    // bot's to answer.
    expect(consumed).toBe(true);
    expect(send.sendLinkButtons).not.toHaveBeenCalled();
  });
});

describe('CommentFunnelService — taps that are not ours', () => {
  it('leaves other engines’ payloads alone', async () => {
    const { prisma } = makePrisma();
    const send = makeSend();

    const consumed = await build(prisma, send).onPostback(
      postbackArgs('flow:node-7'),
    );

    expect(consumed).toBe(false);
    expect(
      prisma.instagram_comment_funnel_runs.findFirst,
    ).not.toHaveBeenCalled();
  });

  it('claims a funnel payload whose run has gone', async () => {
    // Recognisably ours. Letting a flow answer a half-finished funnel
    // is worse than answering nothing.
    const { prisma } = makePrisma({ run: null });
    const send = makeSend();

    const consumed = await build(prisma, send).onPostback(
      postbackArgs(`c2dm:${RUN_ID}:optin`),
    );

    expect(consumed).toBe(true);
    expect(send.sendLinkButtons).not.toHaveBeenCalled();
  });
});
