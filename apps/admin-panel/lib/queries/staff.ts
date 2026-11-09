import 'server-only';

import { cache } from 'react';

import { prisma } from '@/lib/prisma';
import { isStaffRole, type StaffRole } from '@/lib/staff/roles';

/**
 * Staff, minus the password hash. Nothing outside lib/auth.ts and the staff
 * actions ever selects `password_hash`.
 */
export type StaffMember = {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
};

const SAFE_SELECT = {
  id: true,
  email: true,
  full_name: true,
  role: true,
  is_active: true,
  last_login_at: true,
  created_at: true,
  created_by: true,
} as const;

export const listStaff = cache(
  async (opts: { activeOnly?: boolean } = {}): Promise<StaffMember[]> => {
    const rows = await prisma.admin_staff.findMany({
      where: opts.activeOnly ? { is_active: true } : undefined,
      select: SAFE_SELECT,
      orderBy: [{ is_active: 'desc' }, { full_name: 'asc' }],
    });
    return rows.flatMap((row) =>
      isStaffRole(row.role)
        ? [
            {
              id: row.id,
              email: row.email,
              name: row.full_name,
              role: row.role,
              isActive: row.is_active,
              lastLoginAt: row.last_login_at,
              createdAt: row.created_at,
              createdBy: row.created_by,
            },
          ]
        : []
    );
  }
);

/** Active staff for assignment pickers. */
export async function assignableStaff(): Promise<StaffMember[]> {
  return listStaff({ activeOnly: true });
}
