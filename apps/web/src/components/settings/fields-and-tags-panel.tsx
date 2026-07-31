'use client';

import { useCan } from '@/hooks/use-can';

import { CustomFieldsSettings } from './custom-fields-settings';
import { PhoneFormatSettings } from './phone-format-settings';
import { SettingsPanelHead } from './settings-panel-head';
import { TagManager } from './tag-manager';

/**
 * "Fields & tags" section — merges the former Tags and Custom Fields
 * tabs. Tags are visible to everyone; the custom-fields catalogue is
 * account-wide config, so the card is admin-gated (mirroring the old
 * hidden-tab behaviour). `custom_fields` RLS rejects non-admin writes
 * regardless.
 *
 * Phone formatting lives here too rather than in its own section: it
 * is contact-shape config, the same as a custom field, and one setting
 * does not earn a rail entry. Its card renders for everyone (disabled
 * for non-admins) so an agent can see which country their typed
 * numbers are being resolved against.
 */
export function FieldsAndTagsPanel() {
  const canEditSettings = useCan('edit-settings');

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title="Fields & tags"
        description="Ways to organize and standardize contacts: colour-coded tags for quick grouping, custom fields for structured data, and how phone numbers are stored."
      />
      <TagManager />
      {canEditSettings ? <CustomFieldsSettings /> : null}
      <PhoneFormatSettings />
    </section>
  );
}
