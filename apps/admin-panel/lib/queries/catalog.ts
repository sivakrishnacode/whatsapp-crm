import 'server-only';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * The Converse AI catalog (C360-011, migration 098) and the facts its
 * internal mapping should be based on.
 *
 * ⚠️ `provider`, `model` and `fallback_*` are INTERNAL routing. They are read
 * here for staff with `catalog.read_mapping` only — the page decides whether
 * to render them, and no customer-facing surface reads this table at all.
 *
 * ⚠️ Nothing in apps/api reads this table yet. The agent runtime still picks
 * its model from ai_agents.model → the workspace's ai_configs → the platform
 * default. The observed-usage reads below are what the runtime ACTUALLY did,
 * which is why they sit beside the mapping: they are the ground truth a
 * mapping must be reconciled with before it is wired in.
 */

export type CatalogEntry = {
  alias: string;
  position: number;
  name: string;
  tagline: string;
  description: string | null;
  isActive: boolean;
  plans: string[];
  provider: string | null;
  model: string | null;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  maxOutputTokens: number | null;
  toolPolicy: 'none' | 'read_only' | 'permissioned';
  promptVersion: string | null;
  notes: string | null;
  updatedBy: string | null;
  updatedAt: Date;
};

export async function listCatalog(): Promise<CatalogEntry[]> {
  const rows = await prisma.ai_model_catalog.findMany({
    orderBy: { position: 'asc' },
  });
  return rows.map((row) => ({
    alias: row.alias,
    position: row.position,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    isActive: row.is_active,
    plans: row.plans,
    provider: row.provider,
    model: row.model,
    fallbackProvider: row.fallback_provider,
    fallbackModel: row.fallback_model,
    maxOutputTokens: row.max_output_tokens,
    toolPolicy:
      row.tool_policy === 'read_only' || row.tool_policy === 'permissioned'
        ? row.tool_policy
        : 'none',
    promptVersion: row.prompt_version,
    notes: row.notes,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }));
}

export type PlanChoice = {
  name: string;
  displayName: string;
  isActive: boolean;
};

/** Plans an alias can be offered on. Inactive ones are listed and labelled. */
export async function catalogPlanChoices(): Promise<PlanChoice[]> {
  return prisma.$queryRaw<PlanChoice[]>(Prisma.sql`
    select
      name as "name",
      display_name as "displayName",
      coalesce(is_active, false) as "isActive"
    from subscription_plans
    order by coalesce(is_active, false) desc, coalesce(price_monthly, 0) asc, name
  `);
}

export type ObservedModelUsage = {
  model: string | null;
  feature: string | null;
  calls: number;
  credits: number;
  inputTokens: number;
  outputTokens: number;
  workspaces: number;
};

/**
 * What the runtime actually ran, from the credit ledger. Platform-credit
 * traffic only: a BYOK workspace is metered by its own provider and writes no
 * usage rows, so its model choices appear in `configuredModels` instead.
 */
export async function observedModelUsage(
  days = 30
): Promise<ObservedModelUsage[]> {
  return prisma.$queryRaw<ObservedModelUsage[]>(Prisma.sql`
    select
      l.model as "model",
      l.feature as "feature",
      (count(*))::int as "calls",
      coalesce(-sum(l.delta), 0)::int as "credits",
      coalesce(sum(l.input_tokens), 0)::float8 as "inputTokens",
      coalesce(sum(l.output_tokens), 0)::float8 as "outputTokens",
      (count(distinct l.account_id))::int as "workspaces"
    from ai_credit_ledger l
    where l.reason = 'usage'
      and l.created_at >= now() - ${`${days} days`}::interval
    group by l.model, l.feature
    order by "credits" desc, "calls" desc
  `);
}

export type ConfiguredModels = {
  agents: { model: string | null; agents: number; active: number }[];
  workspaces: {
    provider: string | null;
    model: string | null;
    creditMode: string;
    workspaces: number;
  }[];
};

/**
 * What is configured, as opposed to what ran: per-agent model overrides
 * (NULL follows the workspace default) and each workspace's provider/model.
 * No key column is selected — whether a key exists is not needed here.
 */
export async function configuredModels(): Promise<ConfiguredModels> {
  const [agents, workspaces] = await Promise.all([
    prisma.$queryRaw<ConfiguredModels['agents']>(Prisma.sql`
      select
        model as "model",
        (count(*))::int as "agents",
        (count(*) filter (where is_active))::int as "active"
      from ai_agents
      group by model
      order by "agents" desc
    `),
    prisma.$queryRaw<ConfiguredModels['workspaces']>(Prisma.sql`
      select
        provider as "provider",
        model as "model",
        coalesce(credit_mode, 'platform') as "creditMode",
        (count(*))::int as "workspaces"
      from ai_configs
      group by provider, model, coalesce(credit_mode, 'platform')
      order by "workspaces" desc
    `),
  ]);
  return { agents, workspaces };
}
