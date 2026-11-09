import type { NextRequest } from 'next/server';

import { recordAudit } from '@/lib/actions/audit';
import { can, requireCapability } from '@/lib/auth';
import { cell, csvResponse, iso } from '@/lib/csv';
import {
  failureRate,
  getPortfolio,
  parsePeriod,
} from '@/lib/queries/portfolio';

/**
 * CSV of Portfolio Analytics' per-client rows, for the same period and segment
 * filters as the page (C360-028: "CSV export permission").
 *
 * - `export` capability required; MRR is included only for `billing.read`,
 *   so an export can never show more money than the page did.
 * - Every export is written to the audit log — exports leave the building.
 * - Cells are quoted and any text starting with = + - @ (or a tab/CR) is
 *   prefixed with an apostrophe, so a workspace named `=HYPERLINK(...)` opens
 *   as text in a spreadsheet instead of executing.
 * - Window and timezone go in the filename; timestamps in the file are ISO
 *   8601 UTC, which no spreadsheet misreads.
 */

export async function GET(request: NextRequest) {
  const staff = await requireCapability('export');
  const money = can(staff, 'billing.read');

  const params = request.nextUrl.searchParams;
  const period = parsePeriod(params.get('period') ?? undefined);
  const p = await getPortfolio({
    period,
    plan: params.get('plan') ?? undefined,
    manager: params.get('manager') ?? undefined,
  });

  const header = [
    'Client ID',
    'Client',
    'Plan',
    'Subscription status',
    'Lifecycle',
    'Health',
    'Account manager',
    'Service tier',
    'Created (UTC)',
    ...(money ? ['MRR'] : []),
    'Outbound',
    'Inbound',
    'Delivered',
    'Failed',
    'Failure rate %',
    'AI-written',
    'Open tickets',
    'Last message (UTC)',
  ];

  const lines = [header.map(cell).join(',')];
  for (const { entry, messaging } of p.clientRows) {
    lines.push(
      [
        cell(entry.accountId),
        cell(entry.name),
        cell(entry.planDisplayName ?? 'No plan'),
        cell(entry.subStatus ?? 'none'),
        cell(entry.lifecycle.stage),
        cell(entry.health.overall),
        cell(entry.managerName ?? 'Unassigned'),
        cell(entry.serviceTier),
        cell(iso(entry.createdAt)),
        ...(money ? [cell(entry.mrr)] : []),
        cell(messaging.outbound),
        cell(messaging.inbound),
        cell(messaging.delivered),
        cell(messaging.failed),
        cell(failureRate(messaging.failed, messaging.outbound)),
        cell(messaging.aiWritten),
        cell(entry.openTickets),
        cell(iso(entry.lastMessageAt)),
      ].join(',')
    );
  }

  const day = new Date().toISOString().slice(0, 10);
  const zone = p.window.timezone.replace(/[^A-Za-z0-9]+/g, '-');
  const filename = `converse360-portfolio_${period}_${zone}_${day}.csv`;

  await recordAudit({
    actor: staff.actor,
    action: 'export.portfolio',
    targetType: 'export',
    summary: `Exported portfolio analytics (${p.window.label.toLowerCase()}, ${p.clientRows.length} clients${
      p.filters.plan || p.filters.manager ? ', segment-filtered' : ''
    }${money ? ', with MRR' : ''}) as CSV.`,
    detail: {
      period,
      filters: p.filters,
      rows: p.clientRows.length,
      includesMoney: money,
    },
  });

  return csvResponse(lines, filename);
}
