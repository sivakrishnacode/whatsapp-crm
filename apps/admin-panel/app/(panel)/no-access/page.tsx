import type { Metadata } from 'next';

import { Card, CardBody } from '@/components/ui/card';
import { ButtonLink } from '@/components/ui/page';
import { requireStaff } from '@/lib/auth';
import {
  ROLE_LABEL,
  STAFF_ROLES,
  roleCan,
  type Capability,
} from '@/lib/staff/roles';

export const metadata: Metadata = {
  title: 'No access · Converse360 Control Center',
};

/**
 * Where `requireCapability()` sends a role that may not open a screen. It
 * names the missing capability and which roles hold it, so the next step is
 * a sentence to a Super Admin rather than a guess.
 */
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ need?: string }>;
}) {
  const staff = await requireStaff();
  const { need } = await searchParams;
  const capability = need as Capability | undefined;
  const holders = capability
    ? STAFF_ROLES.filter((role) => {
        try {
          return roleCan(role, capability);
        } catch {
          return false;
        }
      })
    : [];

  return (
    <div className="mx-auto max-w-xl pt-10">
      <Card>
        <CardBody className="space-y-3 py-8 text-center">
          <p className="text-muted text-[11px] font-semibold tracking-wider uppercase">
            403 · Not permitted
          </p>
          <h1 className="text-ink text-xl font-bold">
            Your role can’t open this screen
          </h1>
          <p className="text-muted text-sm leading-relaxed">
            You are signed in as{' '}
            <strong className="text-ink-2">{ROLE_LABEL[staff.role]}</strong>.
            {holders.length > 0 ? (
              <>
                {' '}
                This needs a role with{' '}
                <code className="text-ink-2">{capability}</code>:{' '}
                {holders.map((role) => ROLE_LABEL[role]).join(', ')}. Ask a
                Super Admin if you need it.
              </>
            ) : null}
          </p>
          <div className="pt-2">
            <ButtonLink href="/" variant="primary">
              Back to Overview
            </ButtonLink>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
