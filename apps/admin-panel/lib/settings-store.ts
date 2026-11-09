import 'server-only';

import { cache } from 'react';

import { prisma } from '@/lib/prisma';
import { parseSettings, type ControlCenterSettings } from '@/lib/settings';

/** The Control Center settings, read once per render pass. */
export const getSettings = cache(async (): Promise<ControlCenterSettings> => {
  const rows = await prisma.admin_settings.findMany({
    select: { key: true, value: true },
  });
  return parseSettings(rows);
});
