'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Phone } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { COUNTRIES } from '@/lib/phone/countries';
import { toE164, formatPhoneDisplay } from '@/lib/whatsapp/phone-utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

/**
 * Default country for phone numbers entered without a country code.
 *
 * Contacts are stored in canonical E.164 (`+919791766444`) on every
 * channel — see migration 059/061. A number typed as `9791766444`
 * carries no country code, so one has to be assumed, and it cannot be
 * assumed globally: the same ten digits are an Indian mobile in one
 * account and a US one in another.
 *
 * Writes go straight to `accounts.default_country`; the
 * `accounts_update` RLS policy (017) already restricts that to
 * admins+, so non-admins see a disabled, read-only control — the same
 * shape as DealsSettings.
 */

/** Sample rendered through the live setting, so the effect is visible. */
const SAMPLE_LOCAL_NUMBER = '9791766444';

export function PhoneFormatSettings() {
  const supabase = createClient();
  const {
    accountId,
    defaultCountry,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();

  const [selected, setSelected] = useState(defaultCountry);
  const [saving, setSaving] = useState(false);

  // Keep the select in sync once the profile (and its account default)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setSelected(defaultCountry);
  }, [defaultCountry]);

  const dirty = selected !== defaultCountry;

  // Preview the *pending* selection, not the saved one — the point of
  // the sample is to answer "what will this change do" before saving.
  const canonicalSample = toE164(SAMPLE_LOCAL_NUMBER, selected);
  const preview = canonicalSample ? formatPhoneDisplay(canonicalSample) : null;

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from('accounts')
      .update({ default_country: selected })
      .eq('id', accountId);
    if (error) {
      toast.error('Failed to save default country');
      setSaving(false);
      return;
    }
    // Pull the new value back into the auth context so the contact
    // form and CSV import normalize against it without a full reload.
    await refreshProfile();
    setSaving(false);
    toast.success('Default country updated');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Phone className="size-4 text-primary" />
          Phone number format
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Contacts are stored in international format so the same person
          looks the same however they reached you — a WhatsApp message,
          a form, or a CSV import. Numbers entered without a country
          code are assumed to be from this country.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:max-w-xs">
          <Label className="text-muted-foreground">Default country</Label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={!canEditSettings || profileLoading}
            className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label} (+{c.callingCode})
              </option>
            ))}
          </select>
          {preview && (
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{SAMPLE_LOCAL_NUMBER}</span> will be
              saved as{' '}
              <span className="font-mono text-foreground">{preview}</span>
            </p>
          )}
          {!canEditSettings && (
            <p className="text-xs text-muted-foreground">
              Only account admins can change the default country.
            </p>
          )}
        </div>

        {canEditSettings && (
          <Button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save'
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
