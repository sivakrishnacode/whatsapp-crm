'use client';

import type { ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { PricingSettings } from '@/components/settings/pricing-settings';
import {
  SECTION_META,
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

/**
 * Settings — panel host only.
 *
 * The section list used to be an in-page left rail (`<SettingsRail>`);
 * it is now the app's second sidebar, so this page renders just the
 * selected panel. `?tab=` remains the single source of truth for which
 * section is active — deep-linkable, and `resolveSection` still maps the
 * legacy `tags` / `custom-fields` values onto their merged home, so
 * every existing link keeps working.
 */
export default function SettingsPage() {
  const searchParams = useSearchParams();
  const section = resolveSection(searchParams.get('tab'));

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverviewLanding />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    whatsapp: <WhatsAppConfig />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    api: <ApiKeysSettings />,
    pricing: <PricingSettings />,
  };

  const meta = SECTION_META[section];

  return (
    <div className="mx-auto max-w-4xl">
      {section !== 'overview' ? (
        <h1 className="mb-6 text-2xl font-bold tracking-tight text-foreground">
          {meta.label}
        </h1>
      ) : null}
      <div className="min-w-0">{panel[section]}</div>
    </div>
  );
}

/**
 * The Overview landing keeps its own heading + intro. Its cards navigate
 * by `?tab=` — the same URL contract the sidebar uses, so the second
 * sidebar's highlight follows along with no extra wiring.
 */
function SettingsOverviewLanding() {
  const router = useRouter();
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Everything in one place — your account and your workspace. Pick a section to
        manage it.
      </p>
      <div className="mt-6">
        <SettingsOverview
          onSelect={(next) => router.push(`/settings?tab=${next}`, { scroll: false })}
        />
      </div>
    </div>
  );
}
