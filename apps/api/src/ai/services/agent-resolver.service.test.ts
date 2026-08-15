import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentResolverService } from './agent-resolver.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * ============================================================
 * Which agent answers, and why it must not change mid-thread.
 *
 * The three rules pinned here are the ones a customer notices when they
 * break:
 *
 *   1. A thread keeps the agent that has been answering it, even if the
 *      routing order changes underneath. Otherwise a customer gets a
 *      different name and a different tone mid-conversation.
 *   2. An agent scoped to a channel does NOT answer other channels —
 *      not even when it is the only agent there is. The wrong agent
 *      talking to a customer is worse than nobody talking to them.
 *   3. An empty `channels` array means EVERY channel, because that is
 *      what every agent migrated from the single-agent schema carries
 *      (migration 084) and they must keep working untouched.
 * ============================================================
 */

const ACCOUNT_ID = 'acc-1';
const CONVERSATION_ID = 'conv-1';

/** The shape this service asks `ai_agents.findFirst` for. */
interface AgentQuery {
  where: {
    account_id: string;
    is_active?: boolean;
    id?: string;
    OR?: Array<Record<string, unknown>>;
  };
  orderBy?: Array<Record<string, string>>;
}

function build(opts: {
  conversation: { channel: string; ai_agent_id: string | null } | null;
  /** What `ai_agents.findFirst` returns, in call order. */
  agentLookups: Array<{ id: string } | null>;
}) {
  const findFirst =
    vi.fn<(args: AgentQuery) => Promise<{ id: string } | null>>();
  for (const result of opts.agentLookups) {
    findFirst.mockResolvedValueOnce(result);
  }
  findFirst.mockResolvedValue(null);

  const findConversation = vi
    .fn<(args: { where: Record<string, string> }) => Promise<unknown>>()
    .mockResolvedValue(opts.conversation);

  const prisma = {
    conversations: {
      findFirst: findConversation,
      update: vi.fn().mockResolvedValue({}),
    },
    ai_agents: { findFirst },
  } as unknown as PrismaService;

  return {
    service: new AgentResolverService(prisma),
    findConversation,
    findFirst,
  };
}

const resolve = (service: AgentResolverService) =>
  service.resolveForConversation({
    accountId: ACCOUNT_ID,
    conversationId: CONVERSATION_ID,
  });

describe('agent routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the agent already answering the thread', async () => {
    const { service, findFirst } = build({
      conversation: { channel: 'whatsapp', ai_agent_id: 'sticky-agent' },
      agentLookups: [{ id: 'sticky-agent' }],
    });

    await expect(resolve(service)).resolves.toEqual({
      agentId: 'sticky-agent',
      sticky: true,
    });

    // One lookup: the sticky agent. Channel routing must not even run —
    // if it did, a reorder would move the conversation to another agent.
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it('re-routes when the sticky agent has been switched off', async () => {
    const { service, findFirst } = build({
      conversation: { channel: 'whatsapp', ai_agent_id: 'paused-agent' },
      // First lookup (sticky, filtered on is_active) misses; second one
      // is the channel search.
      agentLookups: [null, { id: 'next-agent' }],
    });

    await expect(resolve(service)).resolves.toEqual({
      agentId: 'next-agent',
      sticky: false,
    });
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('asks for agents on this channel OR scoped to none, in priority order', async () => {
    const { service, findFirst } = build({
      conversation: { channel: 'instagram', ai_agent_id: null },
      agentLookups: [{ id: 'ig-agent' }],
    });

    await resolve(service);

    const { where, orderBy } = findFirst.mock.calls[0][0];
    expect(where.account_id).toBe(ACCOUNT_ID);
    expect(where.is_active).toBe(true);
    expect(where.OR).toEqual([
      { channels: { isEmpty: true } },
      { channels: { has: 'instagram' } },
    ]);
    expect(orderBy).toEqual([{ priority: 'asc' }, { created_at: 'asc' }]);
  });

  it('answers with nobody when no active agent covers the channel', async () => {
    const { service } = build({
      conversation: { channel: 'web', ai_agent_id: null },
      agentLookups: [null],
    });

    // Null, not "the first agent we can find": an agent scoped to
    // WhatsApp must not start answering the web widget.
    await expect(resolve(service)).resolves.toBeNull();
  });

  it('ignores a conversation belonging to another workspace', async () => {
    const { service, findConversation } = build({
      conversation: null,
      agentLookups: [],
    });

    await expect(resolve(service)).resolves.toBeNull();

    // Pinned to the account, not just to the id: Prisma bypasses RLS, so
    // an unscoped read would route one tenant's message with another
    // tenant's agent.
    expect(findConversation.mock.calls[0][0].where).toEqual({
      id: CONVERSATION_ID,
      account_id: ACCOUNT_ID,
    });
  });
});
