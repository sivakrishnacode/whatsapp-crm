import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  SeverityBadge,
  SlaBadge,
  TicketStatusBadge,
  CATEGORY_LABEL,
} from '@/components/ops/badges';
import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { ButtonLink } from '@/components/ui/page';
import {
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
} from '@/components/ui/table';
import { can, requireCapability } from '@/lib/auth';
import { formatAgo, formatDateTime } from '@/lib/format';
import { isUuid } from '@/lib/ids';
import { listClientTickets } from '@/lib/queries/clients';
import { activeClock } from '@/lib/sla';

export const metadata: Metadata = { title: 'Tickets · Customer 360' };

export default async function ClientTicketsPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const staff = await requireCapability('clients.read');
  const { accountId } = await params;
  if (!isUuid(accountId)) notFound();

  const tickets = await listClientTickets(accountId);
  const now = new Date();

  return (
    <Card>
      <CardHeader
        title="Support tickets"
        description="Every ticket raised for this client, open first. The SLA clock is 24×7 and does not pause while waiting on the customer."
        action={
          can(staff, 'tickets.work') ? (
            <ButtonLink
              href={`/support/new?accountId=${accountId}`}
              variant="primary"
              size="sm"
            >
              Open ticket
            </ButtonLink>
          ) : null
        }
      />
      {tickets.length === 0 ? (
        <EmptyState title="No tickets yet">
          Tickets opened from the Support Desk, the incident monitor or this
          page will appear here.
        </EmptyState>
      ) : (
        <TableWrap>
          <Table minWidth="52rem">
            <THead>
              <tr>
                <TH>Ticket</TH>
                <TH>Severity</TH>
                <TH>Status</TH>
                <TH>Tier</TH>
                <TH>Assignee</TH>
                <TH>SLA</TH>
                <TH>Opened</TH>
              </tr>
            </THead>
            <TBody>
              {tickets.map((t) => {
                const { kind, clock } = activeClock(
                  {
                    status: t.status,
                    created_at: t.createdAt,
                    first_response_due_at: t.firstResponseDueAt,
                    first_responded_at: t.firstRespondedAt,
                    resolution_due_at: t.resolutionDueAt,
                    resolved_at: t.resolvedAt,
                  },
                  now
                );
                return (
                  <TR key={t.id}>
                    <TD>
                      <Link
                        href={`/support/${t.number}`}
                        className="text-ink font-semibold hover:underline"
                      >
                        SUP-{t.number}
                      </Link>
                      <p className="text-ink-2 max-w-sm truncate text-xs">
                        {t.subject}
                      </p>
                      <p className="text-muted text-xs">
                        {CATEGORY_LABEL[t.category] ?? t.category}
                      </p>
                    </TD>
                    <TD>
                      <SeverityBadge severity={t.severity} />
                    </TD>
                    <TD>
                      <TicketStatusBadge status={t.status} />
                    </TD>
                    <TD>{t.tier}</TD>
                    <TD>
                      {t.assigneeName ?? (
                        <span className="text-muted">Unassigned</span>
                      )}
                    </TD>
                    <TD>
                      <SlaBadge clock={clock} />
                      <p className="text-muted mt-0.5 text-[11px]">
                        {kind === 'first_response'
                          ? 'first response'
                          : 'resolution'}
                      </p>
                    </TD>
                    <TD title={formatDateTime(t.createdAt)}>
                      {formatAgo(t.createdAt)}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}
