import { StatusBadge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/card';
import { SubscriberIdentity } from '@/components/subscriber/identity';
import {
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui/table';
import { formatDate, formatMoney, formatRelativeDays } from '@/lib/format';
import type { SubscriberRow } from '@/lib/queries/sql';

/**
 * The compact subscriber table the dashboard cards share (trials ending,
 * renewals due, recently started). One markup, three lists — the only thing that
 * varies is which date column matters, which the caller names and supplies.
 */
export function SubscriberMiniTable({
  rows,
  dateLabel,
  dateOf,
  amountLabel = 'Amount',
  amountOf,
  emptyMessage,
  relativeDate = true,
}: {
  rows: SubscriberRow[];
  dateLabel: string;
  dateOf: (row: SubscriberRow) => Date | null;
  amountLabel?: string;
  amountOf?: (row: SubscriberRow) => number;
  emptyMessage: string;
  relativeDate?: boolean;
}) {
  if (rows.length === 0) return <EmptyState>{emptyMessage}</EmptyState>;

  const amount = amountOf ?? ((row: SubscriberRow) => row.periodAmount);

  return (
    <TableWrap>
      {/* Narrower floor than the full-page tables: these cards sit two-up in
       * the dashboard grid, and 42rem there clips the amount column. */}
      <Table minWidth="34rem">
        <THead>
          <TR>
            <TH>Subscriber</TH>
            <TH>Plan</TH>
            <TH>Status</TH>
            <TH>{dateLabel}</TH>
            <TH align="right">{amountLabel}</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => {
            const date = dateOf(row);

            return (
              <TR key={row.userId}>
                <TD>
                  <SubscriberIdentity
                    userId={row.userId}
                    fullName={row.fullName}
                    email={row.email}
                    accountName={row.accountName}
                  />
                </TD>
                <TD>
                  <span className="text-ink-2">{row.planDisplayName}</span>
                  {row.billingCycle ? (
                    <span className="text-muted block text-xs">
                      {row.billingCycle}
                    </span>
                  ) : null}
                </TD>
                <TD>
                  <StatusBadge status={row.status} />
                </TD>
                <TD>
                  <span className="text-ink-2">{formatDate(date)}</span>
                  {relativeDate && date ? (
                    <span className="text-muted block text-xs">
                      {formatRelativeDays(date)}
                    </span>
                  ) : null}
                </TD>
                <TD align="right">
                  <span className="text-ink font-medium">
                    {formatMoney(amount(row))}
                  </span>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </TableWrap>
  );
}
