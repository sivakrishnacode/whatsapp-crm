import type { Metadata } from 'next';

import { CatalogForm } from '@/components/catalog/catalog-form';
import { Badge, Pill } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Callout, PageHeader, ScopeLine } from '@/components/ui/page';
import {
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui/table';
import { can, requireCapability } from '@/lib/auth';
import { adminTimezone } from '@/lib/env';
import { formatCredits, formatDateTime, formatNumber } from '@/lib/format';
import {
  catalogPlanChoices,
  configuredModels,
  listCatalog,
  observedModelUsage,
  type CatalogEntry,
} from '@/lib/queries/catalog';

export const metadata: Metadata = {
  title: 'AI Catalog · Converse360 Control Center',
};

const TOOL_POLICY_LABEL: Record<CatalogEntry['toolPolicy'], string> = {
  none: 'Answers only',
  read_only: 'Read-only tools',
  permissioned: 'Permissioned actions',
};

const PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

const FEATURE_LABEL: Record<string, string> = {
  draft: 'Inbox drafts',
  auto_reply: 'Auto-replies',
  playground: 'Playground',
  embedding: 'Knowledge indexing',
  automation_draft: 'Build automation with AI',
  flow_draft: 'Build flow with AI',
};

/**
 * Converse AI Catalog (C360-011): branded personas 01–06 and, for staff who
 * may see it, the provider/model each one is meant to route to.
 *
 * Everyone with clients.read sees what customers would see. The mapping and
 * the observed-usage tables need `catalog.read_mapping` (Super Admin, L3);
 * editing needs `catalog.manage` (Super Admin). The handoff is explicit that
 * vendor model ids never reach a customer — they also do not reach staff
 * who have no reason to know them.
 */
export default async function CatalogPage() {
  const staff = await requireCapability('clients.read');
  const showMapping = can(staff, 'catalog.read_mapping');
  const canEdit = can(staff, 'catalog.manage');

  const [entries, plans, usage, configured] = await Promise.all([
    listCatalog(),
    catalogPlanChoices(),
    showMapping ? observedModelUsage(30) : Promise.resolve([]),
    showMapping
      ? configuredModels()
      : Promise.resolve({ agents: [], workspaces: [] }),
  ]);

  const planLabel = new Map(plans.map((p) => [p.name, p.displayName]));
  const mapped = entries.filter((e) => e.provider && e.model).length;
  const active = entries.filter((e) => e.isActive).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Platform"
        title="AI Catalog"
        description="The Converse 01–06 personas customers choose from. Aliases are product personas, not six different foundation models — several may route to the same backend."
        actions={
          <p className="flex flex-wrap gap-2">
            <Pill
              tone={active > 0 ? 'good' : 'neutral'}
              glyph={active > 0 ? '●' : '○'}
            >
              {active} of {entries.length} active
            </Pill>
            {showMapping ? (
              <Pill
                tone={mapped === entries.length ? 'good' : 'warn'}
                glyph={mapped === entries.length ? '●' : '▲'}
              >
                {mapped} of {entries.length} mapped
              </Pill>
            ) : null}
          </p>
        }
      />

      <Callout tone="warn" title="Not wired to the agent runtime yet">
        apps/api does not read this catalog. Agents still run on the model set
        on each agent, or the workspace&apos;s own provider, or the platform
        default (
        {showMapping
          ? 'see “what actually ran” below'
          : 'visible to Super Admin and L3'}
        ). Editing an alias here changes what the catalog says, not what any
        customer&apos;s bot runs — until the runtime and the customer-facing
        model picker are built to read it.
      </Callout>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <Card key={entry.alias}>
            <CardBody className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-muted text-[11px] font-semibold tracking-wider uppercase">
                    Converse {entry.alias.slice(-2)}
                  </p>
                  <h2 className="text-ink text-lg font-bold tracking-tight">
                    {entry.name}
                  </h2>
                  <p className="text-ink-2 text-sm">{entry.tagline}</p>
                </div>
                {entry.isActive ? (
                  <Pill tone="good" glyph="●">
                    Active
                  </Pill>
                ) : (
                  <Pill tone="neutral" glyph="○">
                    Inactive
                  </Pill>
                )}
              </div>
              {entry.description ? (
                <p className="text-muted text-xs leading-relaxed">
                  {entry.description}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                <Badge>{TOOL_POLICY_LABEL[entry.toolPolicy]}</Badge>
                {entry.plans.length === 0 ? (
                  <Badge tone="outline">All plans</Badge>
                ) : (
                  entry.plans.map((plan) => (
                    <Badge key={plan} tone="outline">
                      {planLabel.get(plan) ?? plan}
                    </Badge>
                  ))
                )}
              </div>

              {showMapping ? (
                <dl className="border-line bg-surface-2 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border px-3 py-2.5 text-xs">
                  <div className="col-span-2">
                    <dt className="text-muted">Routes to</dt>
                    <dd className="text-ink-2 font-mono break-all">
                      {entry.provider && entry.model
                        ? `${PROVIDER_LABEL[entry.provider] ?? entry.provider} · ${entry.model}`
                        : 'Not mapped'}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted">Fallback</dt>
                    <dd className="text-ink-2 font-mono break-all">
                      {entry.fallbackProvider && entry.fallbackModel
                        ? `${PROVIDER_LABEL[entry.fallbackProvider] ?? entry.fallbackProvider} · ${entry.fallbackModel}`
                        : 'None'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Max output</dt>
                    <dd className="text-ink-2">
                      {entry.maxOutputTokens
                        ? `${formatNumber(entry.maxOutputTokens)} tokens`
                        : 'Provider default'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Prompt version</dt>
                    <dd className="text-ink-2">{entry.promptVersion ?? '—'}</dd>
                  </div>
                  {entry.notes ? (
                    <div className="col-span-2">
                      <dt className="text-muted">Notes</dt>
                      <dd className="text-ink-2">{entry.notes}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}

              <p className="text-muted text-[11px]">
                {entry.updatedBy
                  ? `Last changed ${formatDateTime(entry.updatedAt)} by ${entry.updatedBy}`
                  : 'Never edited since it was seeded'}
              </p>

              {canEdit ? (
                <details className="border-line border-t pt-3">
                  <summary className="text-primary hover:text-primary-hover cursor-pointer text-sm font-semibold">
                    Edit {entry.name}
                  </summary>
                  <div className="mt-4">
                    <CatalogForm entry={entry} plans={plans} />
                  </div>
                </details>
              ) : null}
            </CardBody>
          </Card>
        ))}
      </div>

      {showMapping ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader
              title="What actually ran — last 30 days"
              description="From the AI credit ledger: every metered call on the platform key, by model and feature. Own-key (BYOK) workspaces are billed by their provider and write no usage rows."
            />
            {usage.length === 0 ? (
              <EmptyState>No metered AI calls in the last 30 days.</EmptyState>
            ) : (
              <TableWrap>
                <Table minWidth="40rem">
                  <THead>
                    <TR>
                      <TH>Model</TH>
                      <TH>Feature</TH>
                      <TH align="right">Calls</TH>
                      <TH align="right">Tokens in / out</TH>
                      <TH align="right">Credits</TH>
                      <TH align="right">Workspaces</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {usage.map((row) => (
                      <TR key={`${row.model}-${row.feature}`}>
                        <TD>
                          <span className="text-ink-2 font-mono text-xs">
                            {row.model ?? 'not recorded'}
                          </span>
                        </TD>
                        <TD>
                          {FEATURE_LABEL[row.feature ?? ''] ??
                            row.feature ??
                            '—'}
                        </TD>
                        <TD align="right">{formatNumber(row.calls)}</TD>
                        <TD align="right">
                          {formatNumber(row.inputTokens)} /{' '}
                          {formatNumber(row.outputTokens)}
                        </TD>
                        <TD align="right">
                          <span className="text-ink font-semibold">
                            {formatCredits(row.credits)}
                          </span>
                        </TD>
                        <TD align="right">{formatNumber(row.workspaces)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
            )}
            <div className="px-5 pb-4">
              <ScopeLine>
                <span>Window: last 30 days, rolling</span>
                <span aria-hidden>·</span>
                <span>Times in {adminTimezone()}</span>
                <span aria-hidden>·</span>
                <span>Source: ai_credit_ledger (reason = usage)</span>
              </ScopeLine>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="What is configured"
              description="Per-agent model overrides, and each workspace's provider. A blank agent model follows the workspace default."
            />
            <CardBody className="space-y-5">
              <div>
                <p className="text-ink-2 mb-2 text-xs font-semibold">Agents</p>
                {configured.agents.length === 0 ? (
                  <p className="text-muted text-sm">No AI agents exist yet.</p>
                ) : (
                  <ul className="divide-line divide-y text-sm">
                    {configured.agents.map((row) => (
                      <li
                        key={row.model ?? 'default'}
                        className="flex items-baseline justify-between gap-3 py-2"
                      >
                        <span className="text-ink-2 font-mono text-xs break-all">
                          {row.model ?? '(workspace default)'}
                        </span>
                        <span className="text-muted shrink-0 text-xs">
                          {formatNumber(row.agents)} agent
                          {row.agents === 1 ? '' : 's'},{' '}
                          {formatNumber(row.active)} on
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-ink-2 mb-2 text-xs font-semibold">
                  Workspace AI settings
                </p>
                {configured.workspaces.length === 0 ? (
                  <p className="text-muted text-sm">
                    No workspace has opened the agent studio yet.
                  </p>
                ) : (
                  <ul className="divide-line divide-y text-sm">
                    {configured.workspaces.map((row) => (
                      <li
                        key={`${row.provider}-${row.model}-${row.creditMode}`}
                        className="flex items-baseline justify-between gap-3 py-2"
                      >
                        <span className="min-w-0">
                          <span className="text-ink-2 font-mono text-xs break-all">
                            {row.provider
                              ? `${PROVIDER_LABEL[row.provider] ?? row.provider} · ${row.model ?? 'default'}`
                              : 'No provider set'}
                          </span>
                          <span className="text-muted block text-[11px]">
                            {row.creditMode === 'byok'
                              ? 'their own key'
                              : 'platform credits'}
                          </span>
                        </span>
                        <span className="text-muted shrink-0 text-xs">
                          {formatNumber(row.workspaces)} workspace
                          {row.workspaces === 1 ? '' : 's'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="text-muted text-xs leading-relaxed">
                Provider keys are never read here — not even to check they
                exist.
              </p>
            </CardBody>
          </Card>
        </div>
      ) : (
        <Callout tone="neutral">
          The provider and model behind each alias are visible to Super Admin
          and Support L3 only.
        </Callout>
      )}
    </div>
  );
}
