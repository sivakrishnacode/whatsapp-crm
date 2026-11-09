import type { Metadata } from 'next';

import { SettingsForm } from '@/components/settings/settings-form';
import { Card, CardBody, CardHeader, DerivedNote } from '@/components/ui/card';
import { Facts } from '@/components/ui/facts';
import { Callout, PageHeader } from '@/components/ui/page';
import { requireCapability } from '@/lib/auth';
import {
  adminTimezone,
  currency,
  maxCreditAdjustment,
  sessionTtlHours,
} from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { prisma } from '@/lib/prisma';
import { getSettings } from '@/lib/settings-store';

export const metadata: Metadata = {
  title: 'System Settings · Converse360 Control Center',
};

/**
 * Control Center settings (Super Admin). The environment card is read-only
 * and prints no secret — not the database URL, not the session secret, not
 * whether a password is "strong"; only facts an operator needs.
 */
export default async function SettingsPage() {
  await requireCapability('settings.manage');

  const [settings, rows, staffCount] = await Promise.all([
    getSettings(),
    prisma.admin_settings.findMany({
      select: { key: true, updated_by: true, updated_at: true },
      orderBy: { updated_at: 'desc' },
    }),
    prisma.admin_staff.count({
      where: { is_active: true, role: 'super_admin' },
    }),
  ]);
  const breakGlass = Boolean(
    process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD
  );
  const last = rows[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="System Settings"
        description="SLA targets, watch windows and the thresholds the health rules use. Changes are audited with their before and after values."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader
            title="Operations settings"
            description={
              last
                ? `Last changed ${formatDateTime(last.updated_at)} by ${last.updated_by ?? 'unknown'}.`
                : 'All values are the built-in defaults.'
            }
          />
          <CardBody>
            <SettingsForm current={settings} />
          </CardBody>
        </Card>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Environment"
              description="Set in the deployment's env file. Read-only here."
            />
            <CardBody>
              <Facts
                items={[
                  {
                    label: 'Currency',
                    value: currency(),
                    hint: 'ADMIN_CURRENCY — plan prices carry no currency column',
                  },
                  {
                    label: 'Timezone',
                    value: adminTimezone(),
                    hint: 'ADMIN_TIMEZONE — every window and timestamp',
                  },
                  {
                    label: 'Session length',
                    value: `${sessionTtlHours()} h`,
                    hint: 'ADMIN_SESSION_TTL_HOURS',
                  },
                  {
                    label: 'Max manual credit adjustment',
                    value: maxCreditAdjustment().toLocaleString('en-IN'),
                    hint: 'ADMIN_MAX_CREDIT_ADJUSTMENT — server-side ceiling',
                  },
                  {
                    label: 'Break-glass login',
                    value: breakGlass ? 'Configured' : 'Disabled',
                    hint: 'ADMIN_USERNAME / ADMIN_PASSWORD',
                  },
                  { label: 'Active Super Admins', value: String(staffCount) },
                ]}
              />
              <DerivedNote>
                Secrets (database URL, session secret, passwords) are never
                displayed.
              </DerivedNote>
            </CardBody>
          </Card>

          {breakGlass && staffCount > 0 ? (
            <Callout tone="warn" title="The break-glass login is still enabled">
              {staffCount} Super Admin account{staffCount === 1 ? '' : 's'}{' '}
              exist. Consider removing ADMIN_USERNAME and ADMIN_PASSWORD from
              the env file so the shared credential stops working; keep a sealed
              copy if you need a way back in.
            </Callout>
          ) : null}
          {!breakGlass && staffCount === 0 ? (
            <Callout tone="bad" title="No way in">
              There is no active Super Admin and no break-glass login. Restore
              ADMIN_USERNAME and ADMIN_PASSWORD before anyone signs out.
            </Callout>
          ) : null}
        </div>
      </div>
    </div>
  );
}
