import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { MRR_EXPR, type SubscriptionStatus } from '@/lib/queries/sql';

/**
 * The tenant side of the panel.
 *
 * ## Why a workspace view exists at all
 *
 * Everything else here is keyed by *user*, because that is how billing is
 * keyed: `user_subscriptions.user_id`. But the product is account-scoped —
 * contacts, conversations, credits, the WhatsApp connection and every AI
 * setting belong to an `accounts` row, and the people are `profiles` hanging
 * off it. "Which plan is Acme on?" and "who can log into Acme?" are questions
 * the subscriber list cannot answer.
 *
 * ## The join that carries the money
 *
 * A plan belongs to the workspace but the subscription row is keyed by user,
 * and `OnboardingService` always writes it for `accounts.owner_user_id` (see
 * the note in CLAUDE.md — making subscriptions genuinely account-scoped is
 * unfinished work). So a workspace's plan is *the owner's subscription*, and
 * that is what these queries join.
 *
 * The consequence is worth surfacing rather than hiding: any OTHER member of
 * the workspace who also carries a subscription row is being billed for a plan
 * their workspace is not using. `getWorkspace` returns those as
 * `duplicateBilling` so the panel can show them instead of quietly summing
 * them into MRR twice.
 *
 * ⚠️ Prisma connects as the database owner, so RLS protects none of this. It is
 * cross-tenant by design — that is the whole point of this app — which is
 * exactly why its auth is separate from the CRM's.
 */

export type CreditMode = 'platform' | 'byok';

export type WorkspaceRow = {
  accountId: string;
  accountName: string;
  createdAt: Date | null;
  /** ISO 3166-1 alpha-2 assumed for phone numbers entered without a code. */
  defaultCountry: string;
  defaultCurrency: string;
  ownerUserId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  members: number;
  pendingInvites: number;
  planName: string | null;
  planDisplayName: string | null;
  status: SubscriptionStatus | null;
  mrr: number;
  periodEnd: Date | null;
  /** Null when the workspace has never opened the AI section at all. */
  creditMode: CreditMode | null;
  creditBalance: number | null;
  creditsSpent30d: number;
  aiActive: boolean;
  autoReplyEnabled: boolean;
  whatsappStatus: string | null;
  contacts: number;
  conversations: number;
  onboardedAt: Date | null;
};

export type WorkspaceSort =
  'recent' | 'name' | 'value' | 'credits' | 'spend' | 'members';

export type WorkspaceCreditFilter = 'all' | 'low' | 'empty' | 'has';

export type WorkspaceListParams = {
  q?: string;
  mode?: CreditMode | 'none' | 'all';
  credits?: WorkspaceCreditFilter;
  channel?: 'whatsapp' | 'none' | 'all';
  sort?: WorkspaceSort;
  page?: number;
  perPage?: number;
};

export type WorkspaceList = {
  rows: WorkspaceRow[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
};

/**
 * Below this a workspace on platform credits is about to stop answering
 * customers. Mirrors `LOW_BALANCE_THRESHOLD` in
 * apps/api/src/ai/credits/credits.constants.ts — duplicated rather than
 * imported because this app deliberately does not depend on the api, and a
 * threshold that only decides which rows get highlighted is not worth a shared
 * package. If the api's number changes, change this one.
 */
export const LOW_CREDIT_THRESHOLD = 50;

/**
 * `accounts` is the anchor and every join is LEFT except the owner's auth row:
 * `owner_user_id` is NOT NULL with a FK, so an account always has one, while a
 * workspace legitimately has no subscription (never finished onboarding), no
 * wallet (never touched AI), no ai_configs and no WhatsApp connection.
 *
 * The subscription is joined on the OWNER, not on any member — see the note at
 * the top of this file.
 */
const WORKSPACE_FROM = Prisma.sql`
  from accounts a
  join auth.users ou on ou.id = a.owner_user_id
  left join profiles op on op.user_id = a.owner_user_id
  left join user_subscriptions s on s.user_id = a.owner_user_id
  left join subscription_plans pl on pl.id = s.plan_id
  left join ai_credit_wallets w on w.account_id = a.id
  left join ai_configs ac on ac.account_id = a.id
  left join whatsapp_config wc on wc.account_id = a.id
  left join account_onboarding ob on ob.account_id = a.id`;

/**
 * Spend over the trailing 30 days, per workspace.
 *
 * A correlated subquery rather than a join+group-by so a workspace with no
 * ledger rows still returns 0 instead of dropping out, and so the aggregate
 * cannot multiply the outer row. `idx_ai_credit_ledger_account` is
 * (account_id, created_at desc), which is exactly this access pattern.
 */
const SPENT_30D_EXPR = Prisma.sql`
  coalesce((
    select -sum(l.delta)
      from ai_credit_ledger l
     where l.account_id = a.id
       and l.delta < 0
       and l.created_at >= now() - interval '30 days'
  ), 0)::int`;

const WORKSPACE_COLUMNS = Prisma.sql`
  a.id as "accountId",
  a.name as "accountName",
  a.created_at as "createdAt",
  a.default_country as "defaultCountry",
  a.default_currency as "defaultCurrency",
  a.owner_user_id as "ownerUserId",
  ou.email as "ownerEmail",
  op.full_name as "ownerName",
  (select count(*) from account_members m2 where m2.account_id = a.id)::int as "members",
  (
    select count(*) from account_invitations i
     where i.account_id = a.id
       and i.accepted_at is null
       and i.expires_at > now()
  )::int as "pendingInvites",
  pl.name as "planName",
  pl.display_name as "planDisplayName",
  s.status as "status",
  (${MRR_EXPR})::float8 as "mrr",
  s.current_period_end as "periodEnd",
  ac.credit_mode as "creditMode",
  w.balance as "creditBalance",
  ${SPENT_30D_EXPR} as "creditsSpent30d",
  -- Since migration 084 a workspace has MANY agents, so these are
  -- "any of them", not "the one". Existence rather than a count: the
  -- list column is a dot, and a number nobody can act on in a list is
  -- noise.
  exists (
    select 1 from ai_agents ag
     where ag.account_id = a.id and ag.is_active
  ) as "aiActive",
  exists (
    select 1 from ai_agents ag
     where ag.account_id = a.id and ag.is_active and ag.auto_reply_enabled
  ) as "autoReplyEnabled",
  wc.status as "whatsappStatus",
  (select count(*) from contacts c where c.account_id = a.id)::int as "contacts",
  (
    select count(*) from conversations cv where cv.account_id = a.id
  )::int as "conversations",
  ob.completed_at as "onboardedAt"`;

const ORDER_BY: Record<WorkspaceSort, Prisma.Sql> = {
  recent: Prisma.sql`order by a.created_at desc nulls last`,
  name: Prisma.sql`order by a.name asc`,
  value: Prisma.sql`order by (${MRR_EXPR}) desc, a.created_at desc`,
  // Nulls last so "no wallet" sorts with zero rather than above 25,000.
  credits: Prisma.sql`order by w.balance desc nulls last`,
  spend: Prisma.sql`order by ${SPENT_30D_EXPR} desc, a.created_at desc`,
  members: Prisma.sql`order by (
    select count(*) from account_members m3 where m3.account_id = a.id
  ) desc, a.created_at desc`,
};

function buildWhere(params: WorkspaceListParams): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

  const q = params.q?.trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(Prisma.sql`(
      a.name ilike ${like}
      or ou.email ilike ${like}
      or op.full_name ilike ${like}
    )`);
  }

  if (params.mode === 'none') {
    conditions.push(Prisma.sql`ac.id is null`);
  } else if (params.mode === 'platform' || params.mode === 'byok') {
    conditions.push(Prisma.sql`ac.credit_mode = ${params.mode}`);
  }

  // "empty" includes a workspace with no wallet row at all: from an
  // operator's point of view "0 credits" and "no wallet yet" are the same
  // situation — the agent cannot answer on our key.
  if (params.credits === 'empty') {
    conditions.push(Prisma.sql`coalesce(w.balance, 0) = 0`);
  } else if (params.credits === 'low') {
    conditions.push(
      Prisma.sql`coalesce(w.balance, 0) between 1 and ${LOW_CREDIT_THRESHOLD}`
    );
  } else if (params.credits === 'has') {
    conditions.push(Prisma.sql`coalesce(w.balance, 0) > 0`);
  }

  if (params.channel === 'whatsapp') {
    conditions.push(Prisma.sql`wc.status = 'connected'`);
  } else if (params.channel === 'none') {
    conditions.push(Prisma.sql`(wc.id is null or wc.status <> 'connected')`);
  }

  return conditions.length
    ? Prisma.sql`where ${Prisma.join(conditions, ' and ')}`
    : Prisma.empty;
}

export async function listWorkspaces(
  params: WorkspaceListParams = {}
): Promise<WorkspaceList> {
  const perPage = Math.min(Math.max(params.perPage ?? 25, 5), 100);
  const page = Math.max(params.page ?? 1, 1);
  const where = buildWhere(params);
  const orderBy = ORDER_BY[params.sort ?? 'recent'];

  const [rows, [totals]] = await Promise.all([
    prisma.$queryRaw<WorkspaceRow[]>(Prisma.sql`
      select ${WORKSPACE_COLUMNS}
      ${WORKSPACE_FROM}
      ${where}
      ${orderBy}
      limit ${perPage} offset ${(page - 1) * perPage}
    `),
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      select (count(*))::int as "total"
      ${WORKSPACE_FROM}
      ${where}
    `),
  ]);

  return {
    rows,
    total: totals.total,
    page,
    perPage,
    pageCount: Math.max(Math.ceil(totals.total / perPage), 1),
  };
}

/** Headline counts for the top of the workspaces page. */
export type WorkspaceTotals = {
  workspaces: number;
  newThisMonth: number;
  onboarded: number;
  whatsappConnected: number;
  aiActive: number;
  onPlatformCredits: number;
  onOwnKey: number;
  soloWorkspaces: number;
};

export async function workspaceTotals(): Promise<WorkspaceTotals> {
  const [row] = await prisma.$queryRaw<WorkspaceTotals[]>(Prisma.sql`
    select
      (select count(*) from accounts)::int as "workspaces",
      (
        select count(*) from accounts
         where created_at >= date_trunc('month', now())
      )::int as "newThisMonth",
      (
        select count(*) from account_onboarding where completed_at is not null
      )::int as "onboarded",
      (
        select count(*) from whatsapp_config where status = 'connected'
      )::int as "whatsappConnected",
      (
        select count(distinct account_id) from ai_agents where is_active
      )::int as "aiActive",
      (
        select count(*) from ai_configs where credit_mode = 'platform'
      )::int as "onPlatformCredits",
      (select count(*) from ai_configs where credit_mode = 'byok')::int as "onOwnKey",
      -- A workspace whose only member is its owner. The signup trigger
      -- creates one of these per user, so this is mostly "how many of our
      -- accounts are a single person" — the denominator for team features.
      (
        select count(*) from accounts a2
         where (select count(*) from account_members m where m.account_id = a2.id) <= 1
      )::int as "soloWorkspaces"
  `);

  return row;
}

/* ============================================================
 * One workspace.
 * ============================================================ */

export type WorkspaceMember = {
  userId: string;
  /** Null when the signup trigger never wrote a profile row for this login. */
  profileId: string | null;
  email: string | null;
  fullName: string | null;
  /** The role held IN THIS WORKSPACE. The same person may hold another
   *  elsewhere — see `otherWorkspaces`. */
  accountRole: 'owner' | 'admin' | 'agent' | 'viewer';
  isAccountOwner: boolean;
  /** How many OTHER workspaces this person belongs to. Zero means removing
   *  them here leaves them in none, which the remove dialog says out loud. */
  otherWorkspaces: number;
  createdAt: Date | null;
  lastSignInAt: Date | null;
  emailConfirmedAt: Date | null;
  bannedUntil: Date | null;
  /** Set when this member carries a subscription row of their own. */
  ownSubscriptionStatus: SubscriptionStatus | null;
  ownSubscriptionPlan: string | null;
  ownSubscriptionMrr: number;
  assignedDeals: number;
};

export type WorkspaceInvite = {
  id: string;
  label: string | null;
  role: string;
  createdAt: Date;
  expiresAt: Date;
  invitedByEmail: string | null;
};

export type WorkspaceWallet = {
  balance: number;
  lifetimePurchased: number;
  lifetimeConsumed: number;
  signupGrantedAt: Date | null;
  lowBalanceNotifiedAt: Date | null;
  updatedAt: Date | null;
};

export type LedgerEntry = {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  feature: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  note: string | null;
  createdAt: Date;
};

export type CreditOrder = {
  id: string;
  packCode: string;
  credits: number;
  /** Minor units (paise). Never mix with plan prices — see ./credits.ts. */
  amountMinor: number;
  currency: string;
  status: string;
  gateway: string;
  gatewayOrderId: string | null;
  creditedAt: Date | null;
  createdAt: Date;
};

export type WorkspaceAi = {
  provider: string | null;
  model: string | null;
  creditMode: CreditMode;
  hasOwnKey: boolean;
  /**
   * Agent counts, not agent facts. A workspace has many agents since
   * migration 084, so "is the AI on" is no longer a yes/no about one
   * row — it is how many of several are switched on.
   */
  agents: number;
  activeAgents: number;
  autoReplyAgents: number;
  testModeAgents: number;
  embeddingsModel: string | null;
  knowledgeDocs: number;
  customActions: number;
  updatedAt: Date | null;
};

export type WorkspaceChannels = {
  whatsappStatus: string | null;
  whatsappNumberId: string | null;
  whatsappTier: string | null;
  whatsappQuality: string | null;
  whatsappTokenExpiresAt: Date | null;
  instagramStatus: string | null;
  instagramUsername: string | null;
  webStatus: string | null;
  adsConnected: boolean;
  adsFundingOk: boolean;
};

export type WorkspaceActivity = {
  contacts: number;
  conversations: number;
  messages: number;
  broadcasts: number;
  automations: number;
  flows: number;
  templates: number;
  apiKeys: number;
  lastMessageAt: Date | null;
};

export type WorkspaceDetail = {
  workspace: WorkspaceRow;
  members: WorkspaceMember[];
  invites: WorkspaceInvite[];
  wallet: WorkspaceWallet | null;
  ledger: LedgerEntry[];
  orders: CreditOrder[];
  ai: WorkspaceAi | null;
  channels: WorkspaceChannels;
  activity: WorkspaceActivity;
  /** Members other than the owner who also have a subscription row. */
  duplicateBilling: WorkspaceMember[];
  enquiries: {
    id: string;
    fullName: string;
    workEmail: string;
    companySize: string | null;
    status: string;
    createdAt: Date;
  }[];
};

export async function getWorkspace(
  accountId: string
): Promise<WorkspaceDetail | null> {
  const [workspace] = await prisma.$queryRaw<WorkspaceRow[]>(Prisma.sql`
    select ${WORKSPACE_COLUMNS}
    ${WORKSPACE_FROM}
    where a.id = ${accountId}::uuid
    limit 1
  `);

  if (!workspace) return null;

  const [
    members,
    invites,
    wallet,
    ledger,
    orders,
    ai,
    channels,
    activity,
    enquiries,
  ] = await Promise.all([
    listMembers(accountId),
    listInvites(accountId),
    getWallet(accountId),
    listLedger(accountId),
    listOrders(accountId),
    getAi(accountId),
    getChannels(accountId),
    getActivity(accountId),
    listEnquiries(accountId),
  ]);

  return {
    workspace,
    members,
    invites,
    wallet,
    ledger,
    orders,
    ai,
    channels,
    activity,
    duplicateBilling: members.filter(
      (m) => !m.isAccountOwner && m.ownSubscriptionStatus !== null
    ),
    enquiries,
  };
}

/**
 * Everyone with a profile on this account.
 *
 * Each member's own subscription is joined so the panel can show the
 * duplicate-billing case described at the top of this file. `assignedDeals` is
 * here because `deals.assigned_to` is a FK to `profiles.id` with no cascade:
 * removing a member whose deals are assigned to them is a decision, and the
 * operator should see the number before making it.
 */
async function listMembers(accountId: string): Promise<WorkspaceMember[]> {
  return prisma.$queryRaw<WorkspaceMember[]>(Prisma.sql`
    -- Migration 095: the MEMBERSHIP is the row that says who is in this
    -- workspace and what they are here. profiles supplies the person, and is
    -- LEFT joined because a membership without a profile row is recoverable
    -- (the signup trigger swallows its own errors) and should still be visible
    -- to an operator rather than silently absent from the list.
    select
      m.user_id as "userId",
      p.id as "profileId",
      u.email as "email",
      p.full_name as "fullName",
      m.role as "accountRole",
      (a.owner_user_id = m.user_id) as "isAccountOwner",
      u.created_at as "createdAt",
      u.last_sign_in_at as "lastSignInAt",
      u.email_confirmed_at as "emailConfirmedAt",
      u.banned_until as "bannedUntil",
      s.status as "ownSubscriptionStatus",
      pl.display_name as "ownSubscriptionPlan",
      (${MRR_EXPR})::float8 as "ownSubscriptionMrr",
      (
        select count(*) from deals d where d.assigned_to = p.id
      )::int as "assignedDeals",
      -- What this operator needs before removing somebody: how many other
      -- workspaces they would still be in afterwards.
      (
        select count(*) from account_members m2
         where m2.user_id = m.user_id and m2.account_id <> m.account_id
      )::int as "otherWorkspaces"
    from account_members m
    join accounts a on a.id = m.account_id
    join auth.users u on u.id = m.user_id
    left join profiles p on p.user_id = m.user_id
    left join user_subscriptions s on s.user_id = m.user_id
    left join subscription_plans pl on pl.id = s.plan_id
    where m.account_id = ${accountId}::uuid
    -- Owner first, then the rest by seniority IN THIS WORKSPACE — the
    -- membership's created_at, not the profile's, which is when they signed up
    -- and for an agency's clients is months earlier.
    order by (a.owner_user_id = m.user_id) desc, m.created_at asc nulls last
  `);
}

/** Live invitations only — an expired or redeemed one is history. */
async function listInvites(accountId: string): Promise<WorkspaceInvite[]> {
  return prisma.$queryRaw<WorkspaceInvite[]>(Prisma.sql`
    select
      i.id as "id",
      i.label as "label",
      i.role::text as "role",
      i.created_at as "createdAt",
      i.expires_at as "expiresAt",
      u.email as "invitedByEmail"
    from account_invitations i
    left join auth.users u on u.id = i.created_by_user_id
    where i.account_id = ${accountId}::uuid
      and i.accepted_at is null
      and i.expires_at > now()
    order by i.created_at desc
  `);
}

async function getWallet(accountId: string): Promise<WorkspaceWallet | null> {
  const [row] = await prisma.$queryRaw<WorkspaceWallet[]>(Prisma.sql`
    select
      balance as "balance",
      lifetime_purchased as "lifetimePurchased",
      lifetime_consumed as "lifetimeConsumed",
      signup_granted_at as "signupGrantedAt",
      low_balance_notified_at as "lowBalanceNotifiedAt",
      updated_at as "updatedAt"
    from ai_credit_wallets
    where account_id = ${accountId}::uuid
  `);
  return row ?? null;
}

async function listLedger(
  accountId: string,
  limit = 25
): Promise<LedgerEntry[]> {
  return prisma.$queryRaw<LedgerEntry[]>(Prisma.sql`
    select
      id as "id",
      delta as "delta",
      balance_after as "balanceAfter",
      reason as "reason",
      feature as "feature",
      model as "model",
      input_tokens as "inputTokens",
      output_tokens as "outputTokens",
      note as "note",
      created_at as "createdAt"
    from ai_credit_ledger
    where account_id = ${accountId}::uuid
    order by created_at desc
    limit ${limit}
  `);
}

/**
 * `amount_minor` is cast to float8 because Prisma hands a bigint column back as
 * a JS BigInt, which cannot cross the server/client boundary or be formatted by
 * Intl. Exact for any realistic amount — float8 holds integers to 2^53, which
 * is ninety trillion rupees in paise.
 */
async function listOrders(
  accountId: string,
  limit = 10
): Promise<CreditOrder[]> {
  return prisma.$queryRaw<CreditOrder[]>(Prisma.sql`
    select
      id as "id",
      pack_code as "packCode",
      credits as "credits",
      (amount_minor)::float8 as "amountMinor",
      currency as "currency",
      status as "status",
      gateway as "gateway",
      gateway_order_id as "gatewayOrderId",
      credited_at as "creditedAt",
      created_at as "createdAt"
    from ai_credit_orders
    where account_id = ${accountId}::uuid
    order by created_at desc
    limit ${limit}
  `);
}

/**
 * The AI setup, minus every secret.
 *
 * `api_key`, `embeddings_api_key` and the encrypted action headers are never
 * selected — not even to test them for length. A support panel has no reason to
 * hold a customer's provider key in a server render, and "we only show the last
 * four" is how the whole key ends up in a log.
 */
async function getAi(accountId: string): Promise<WorkspaceAi | null> {
  // Anchored on `accounts`, not on `ai_configs`: a workspace can have
  // agents and no config row at all (it runs on the platform key and has
  // never pasted one), and anchoring on the config would report that
  // workspace as having no AI whatsoever.
  const [row] = await prisma.$queryRaw<WorkspaceAi[]>(Prisma.sql`
    select
      ac.provider as "provider",
      ac.model as "model",
      coalesce(ac.credit_mode, 'platform') as "creditMode",
      (ac.api_key is not null) as "hasOwnKey",
      (select count(*) from ai_agents ag where ag.account_id = a.id)::int
        as "agents",
      (
        select count(*) from ai_agents ag
         where ag.account_id = a.id and ag.is_active
      )::int as "activeAgents",
      (
        select count(*) from ai_agents ag
         where ag.account_id = a.id and ag.is_active and ag.auto_reply_enabled
      )::int as "autoReplyAgents",
      (
        select count(*) from ai_agents ag
         where ag.account_id = a.id and ag.test_mode
      )::int as "testModeAgents",
      ac.embeddings_model as "embeddingsModel",
      (
        select count(*) from ai_knowledge_documents d
         where d.account_id = a.id
      )::int as "knowledgeDocs",
      (
        select count(*) from ai_agent_actions ag
         where ag.account_id = a.id
      )::int as "customActions",
      greatest(
        ac.updated_at,
        (select max(ag.updated_at) from ai_agents ag where ag.account_id = a.id)
      ) as "updatedAt"
    from accounts a
    left join ai_configs ac on ac.account_id = a.id
    where a.id = ${accountId}::uuid
  `);
  return row ?? null;
}

async function getChannels(accountId: string): Promise<WorkspaceChannels> {
  const [row] = await prisma.$queryRaw<WorkspaceChannels[]>(Prisma.sql`
    select
      wc.status as "whatsappStatus",
      wc.phone_number_id as "whatsappNumberId",
      wc.messaging_limit_tier as "whatsappTier",
      wc.quality_rating as "whatsappQuality",
      wc.token_expires_at as "whatsappTokenExpiresAt",
      ig.status as "instagramStatus",
      ig.ig_username as "instagramUsername",
      web.status as "webStatus",
      (ads.id is not null) as "adsConnected",
      coalesce(ads.funding_ok, false) as "adsFundingOk"
    from accounts a
    left join whatsapp_config wc on wc.account_id = a.id
    left join instagram_config ig on ig.account_id = a.id
    left join web_config web on web.account_id = a.id
    left join meta_ads_config ads on ads.account_id = a.id
    where a.id = ${accountId}::uuid
  `);
  return row;
}

async function getActivity(accountId: string): Promise<WorkspaceActivity> {
  const [row] = await prisma.$queryRaw<WorkspaceActivity[]>(Prisma.sql`
    select
      (select count(*) from contacts where account_id = ${accountId}::uuid)::int
        as "contacts",
      (select count(*) from conversations where account_id = ${accountId}::uuid)::int
        as "conversations",
      (
        select count(*) from messages m
        join conversations c on c.id = m.conversation_id
        where c.account_id = ${accountId}::uuid
      )::int as "messages",
      (select count(*) from broadcasts where account_id = ${accountId}::uuid)::int
        as "broadcasts",
      (select count(*) from automations where account_id = ${accountId}::uuid)::int
        as "automations",
      (select count(*) from flows where account_id = ${accountId}::uuid)::int
        as "flows",
      (
        select count(*) from message_templates where account_id = ${accountId}::uuid
      )::int as "templates",
      (
        select count(*) from api_keys
         where account_id = ${accountId}::uuid and revoked_at is null
      )::int as "apiKeys",
      -- The one honest "is this account alive?" signal: last_message_at is
      -- maintained on the conversation, so this needs no scan of messages.
      (
        select max(last_message_at) from conversations
         where account_id = ${accountId}::uuid
      ) as "lastMessageAt"
  `);
  return row;
}

async function listEnquiries(accountId: string) {
  return prisma.$queryRaw<WorkspaceDetail['enquiries']>(Prisma.sql`
    select
      id as "id",
      full_name as "fullName",
      work_email as "workEmail",
      company_size as "companySize",
      status as "status",
      created_at as "createdAt"
    from plan_enquiries
    where account_id = ${accountId}::uuid
    order by created_at desc
    limit 5
  `);
}
