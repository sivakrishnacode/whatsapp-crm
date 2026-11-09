import type { Metadata } from 'next';

import { CreateStaff } from '@/components/staff/create-staff';
import { StaffActions } from '@/components/staff/staff-actions';
import { Pill } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Callout, PageHeader } from '@/components/ui/page';
import { StatRow, StatTile } from '@/components/ui/stat';
import {
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui/table';
import { requireCapability } from '@/lib/auth';
import { formatAgo, formatDate, formatNumber, initialsOf } from '@/lib/format';
import { listStaff } from '@/lib/queries/staff';
import {
  ROLE_CAPABILITIES,
  ROLE_LABEL,
  ROLE_SUMMARY,
  STAFF_ROLES,
  type Capability,
} from '@/lib/staff/roles';

export const metadata: Metadata = {
  title: 'Staff & Access · Converse360 Control Center',
};

/**
 * The capability columns of the role matrix, in the words an operator uses.
 * Ordered from "everyone has it" to "Super Admin only".
 */
const MATRIX: { capability: Capability; label: string }[] = [
  { capability: 'clients.read', label: 'Read clients, health, onboarding' },
  { capability: 'clients.notes', label: 'Notes & tasks' },
  { capability: 'tickets.work', label: 'Work the support desk' },
  { capability: 'clients.manage', label: 'Assign owners, pin lifecycle' },
  { capability: 'members.manage', label: 'Change workspace members' },
  { capability: 'billing.read', label: 'See money' },
  { capability: 'billing.manage', label: 'Edit subscriptions & prices' },
  { capability: 'credits.adjust', label: 'Move AI credits' },
  { capability: 'integrations.read', label: 'API & webhook diagnostics' },
  { capability: 'catalog.read_mapping', label: 'See model mapping' },
  { capability: 'audit.read', label: 'Full audit log' },
  { capability: 'export', label: 'CSV exports' },
  { capability: 'catalog.manage', label: 'Edit AI catalog' },
  { capability: 'settings.manage', label: 'System settings' },
  { capability: 'staff.manage', label: 'Manage staff' },
];

/**
 * Staff & Access — who can sign in to the Control Center and what each role
 * may do. Super Admin only: the page itself and every action behind it.
 */
export default async function StaffPage() {
  const me = await requireCapability('staff.manage');
  const staff = await listStaff();

  const active = staff.filter((s) => s.isActive);
  const superAdmins = active.filter((s) => s.role === 'super_admin').length;
  const neverSignedIn = active.filter((s) => !s.lastLoginAt).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Platform"
        title="Staff & Access"
        description="Who can sign in to the Control Center, with which role. Access is per person and role-scoped; every change below signs the affected person out on their next request and is written to the audit log."
      />

      <StatRow>
        <StatTile
          label="Active staff"
          value={formatNumber(active.length)}
          context={`${formatNumber(staff.length - active.length)} deactivated`}
        />
        <StatTile
          label="Super Admins"
          value={formatNumber(superAdmins)}
          context={
            superAdmins === 0
              ? 'None yet — only the break-glass login can govern'
              : superAdmins === 1
                ? 'One person holds the keys — consider a second'
                : 'can manage staff and settings'
          }
          tone={
            superAdmins === 0
              ? 'critical'
              : superAdmins === 1
                ? 'warning'
                : 'neutral'
          }
        />
        <StatTile
          label="Never signed in"
          value={formatNumber(neverSignedIn)}
          context="Active accounts still on their temporary password"
          tone={neverSignedIn > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="You"
          value={ROLE_LABEL[me.role]}
          context={me.isBreakGlass ? 'break-glass login' : me.email}
        />
      </StatRow>

      <Callout
        tone={me.isBreakGlass ? 'warn' : 'info'}
        title="The break-glass login"
      >
        The <code>ADMIN_USERNAME</code> / <code>ADMIN_PASSWORD</code> pair in
        the deployment env file signs in as a Super Admin with no staff row. It
        is how the first account here gets created and how you get back in if
        every Super Admin is lost. It is not a person: it cannot own a client or
        a ticket, and the audit log marks its changes &ldquo;break-glass&rdquo;.
        Once two Super Admins exist, unset it.
        {me.isBreakGlass
          ? ' You are signed in with it now — create your own account below.'
          : ''}
      </Callout>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Staff accounts"
            description="Deactivating keeps the person's name on every client, ticket and note they touched — history is never rewritten."
          />
          {staff.length === 0 ? (
            <EmptyState title="No staff accounts yet">
              Everyone is signing in with the break-glass login. Create the
              first account on the right.
            </EmptyState>
          ) : (
            <TableWrap>
              <Table minWidth="48rem">
                <THead>
                  <TR>
                    <TH>Person</TH>
                    <TH>Role</TH>
                    <TH>Last sign-in</TH>
                    <TH align="right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {staff.map((person) => (
                    <TR key={person.id}>
                      <TD>
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            aria-hidden
                            className="bg-primary-soft text-primary-soft-ink grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold"
                          >
                            {initialsOf(person.name, person.email)}
                          </span>
                          <span className="min-w-0">
                            <span className="text-ink block truncate font-semibold">
                              {person.name}
                              {person.id === me.id ? (
                                <span className="text-muted font-normal">
                                  {' '}
                                  (you)
                                </span>
                              ) : null}
                            </span>
                            <span className="text-muted block truncate text-xs">
                              {person.email}
                            </span>
                          </span>
                        </div>
                      </TD>
                      <TD>
                        <span className="flex flex-col items-start gap-1">
                          <Pill
                            tone={
                              person.role === 'super_admin'
                                ? 'primary'
                                : 'neutral'
                            }
                          >
                            {ROLE_LABEL[person.role]}
                          </Pill>
                          {person.isActive ? null : (
                            <Pill tone="bad" glyph="■">
                              Deactivated
                            </Pill>
                          )}
                        </span>
                      </TD>
                      <TD>
                        <span className="text-ink-2">
                          {person.lastLoginAt
                            ? formatAgo(person.lastLoginAt)
                            : 'Never'}
                        </span>
                        <span className="text-muted block text-xs">
                          added {formatDate(person.createdAt)}
                          {person.createdBy ? ` by ${person.createdBy}` : ''}
                        </span>
                      </TD>
                      <TD align="right">
                        <StaffActions
                          staffId={person.id}
                          role={person.role}
                          isActive={person.isActive}
                          isSelf={person.id === me.id}
                        />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Add a staff member"
            description="They get a generated temporary password, shown to you once."
          />
          <CardBody>
            <CreateStaff />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="What each role can do"
          description="The one permission table. The navigation, every page and every action read it, so a role can never see a button that would refuse it. No role can read a customer secret — there is no screen that loads one."
        />
        <TableWrap>
          <Table minWidth="60rem">
            <THead>
              <TR>
                <TH>Capability</TH>
                {STAFF_ROLES.map((role) => (
                  <TH key={role}>{ROLE_LABEL[role]}</TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {MATRIX.map((row) => (
                <TR key={row.capability}>
                  <TD>
                    <span className="text-ink-2">{row.label}</span>
                    <span className="text-muted block font-mono text-[11px]">
                      {row.capability}
                    </span>
                  </TD>
                  {STAFF_ROLES.map((role) => {
                    const has = ROLE_CAPABILITIES[role].has(row.capability);
                    return (
                      <TD key={role}>
                        {has ? (
                          <span className="text-good-fg text-sm font-semibold">
                            <span aria-hidden>✓ </span>Yes
                          </span>
                        ) : (
                          <span className="text-muted text-sm">
                            <span aria-hidden>– </span>No
                          </span>
                        )}
                      </TD>
                    );
                  })}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-2 xl:grid-cols-3">
            {STAFF_ROLES.map((role) => (
              <div key={role}>
                <dt className="text-ink font-semibold">{ROLE_LABEL[role]}</dt>
                <dd className="text-muted mt-0.5 text-xs leading-relaxed">
                  {ROLE_SUMMARY[role]}
                </dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
