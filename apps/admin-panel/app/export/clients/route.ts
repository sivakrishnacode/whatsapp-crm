import type { NextRequest } from 'next/server';

import { recordAudit } from '@/lib/actions/audit';
import { can, requireCapability } from '@/lib/auth';
import { cell, csvResponse, iso } from '@/lib/csv';
import { filterRoster, normaliseFilters } from '@/lib/queries/directory';
import { getRoster } from '@/lib/queries/roster';

/**
 * CSV of the client directory with EXACTLY the filters on screen — the same
 * `normaliseFilters` + `filterRoster` the page uses, so an export never holds
 * a different set than the operator was looking at.
 *
 * `export` capability required; MRR and subscription status only with
 * `billing.read`. Every export is audited — exports leave the building.
 */
export async function GET(request: NextRequest) {
  const staff = await requireCapability('export');
  const money = can(staff, 'billing.read');
  const search = request.nextUrl.searchParams;
  const params = Object.fromEntries(search.entries());
  const f = normaliseFilters(params, { allowMoneySort: money });
  const rows = filterRoster(await getRoster(), f);

  const header = [
    'Client ID',
    'Client',
    'Owner email',
    'Members',
    'Account manager',
    'Service tier',
    'Tags',
    'Plan',
    ...(money ? ['Subscription status', 'MRR'] : []),
    'Lifecycle',
    'Lifecycle pinned',
    'Health',
    'Setup completion %',
    'WhatsApp status',
    'Phone number ID',
    'WABA ID',
    'Open tickets',
    'Last message (UTC)',
    'Renewal / trial end (UTC)',
    'Created (UTC)',
  ];

  const lines = [header.map(cell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        cell(r.accountId),
        cell(r.name),
        cell(r.ownerEmail),
        cell(r.members),
        cell(r.managerName ?? 'Unassigned'),
        cell(r.serviceTier),
        cell(r.tags.join('; ')),
        cell(r.planDisplayName ?? 'No plan'),
        ...(money ? [cell(r.subStatus ?? 'none'), cell(r.mrr)] : []),
        cell(r.lifecycle.stage),
        cell(r.lifecycle.pinned ? 'yes' : 'no'),
        cell(r.health.overall),
        cell(r.health.completion.percent),
        cell(r.health.evidence.wa?.status ?? 'not connected'),
        cell(r.phoneNumberId),
        cell(r.wabaId),
        cell(r.openTickets),
        cell(iso(r.lastMessageAt)),
        cell(iso(r.subStatus === 'trial' ? r.trialEndAt : r.periodEnd)),
        cell(iso(r.createdAt)),
      ].join(',')
    );
  }

  const filtered = search.toString().length > 0;
  await recordAudit({
    actor: staff.actor,
    action: 'export.clients',
    targetType: 'export',
    summary: `Exported the client directory (${rows.length} clients${filtered ? ', filtered' : ''}${
      money ? ', with MRR' : ''
    }) as CSV.`,
    detail: { filters: f, rows: rows.length, includesMoney: money },
  });

  const day = new Date().toISOString().slice(0, 10);
  return csvResponse(lines, `converse360-clients_${day}.csv`);
}
