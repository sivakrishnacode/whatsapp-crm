import type { Metadata } from 'next';

import { PasswordForm } from '@/components/staff/password-form';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { Callout, PageHeader } from '@/components/ui/page';
import { requireStaff } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { MIN_PASSWORD_LENGTH } from '@/lib/staff/password';
import { ROLE_LABEL, ROLE_SUMMARY } from '@/lib/staff/roles';

export const metadata: Metadata = {
  title: 'Your account · Converse360 Control Center',
};

/**
 * Your own account: who you are signed in as, and changing your password.
 * Open to every signed-in staff member; the break-glass login has no stored
 * password and is told so.
 */
export default async function AccountPage() {
  const staff = await requireStaff();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Your account"
        description="Changing your password signs out every other session you have — a stolen cookie included."
      />

      <Card>
        <CardHeader title="Signed in as" />
        <CardBody>
          <Facts
            items={[
              { label: 'Name', value: staff.name },
              { label: 'Email', value: staff.email },
              {
                label: 'Role',
                value: ROLE_LABEL[staff.role],
                hint: ROLE_SUMMARY[staff.role],
              },
              {
                label: 'This session ends',
                value: formatDateTime(new Date(staff.sessionExpiresAt * 1000)),
              },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Change password" />
        <CardBody>
          {staff.isBreakGlass ? (
            <Callout tone="warn" title="Break-glass login">
              This login is defined by ADMIN_USERNAME / ADMIN_PASSWORD in the
              deployment env file, so it has no stored password to change here.
              Create a staff account for yourself in Staff &amp; Access and use
              that day to day.
            </Callout>
          ) : (
            <PasswordForm minLength={MIN_PASSWORD_LENGTH} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
