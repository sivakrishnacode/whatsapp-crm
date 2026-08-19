'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCompact, type AdAudience } from '@/lib/ads/types';

interface Tag {
  id: string;
  name: string;
}

/** Lookalike closeness. 1% is the most similar to the seed. */
const RATIOS = [
  { value: '0.01', label: '1% — closest match' },
  { value: '0.03', label: '3% — balanced' },
  { value: '0.05', label: '5% — broader reach' },
  { value: '0.1', label: '10% — widest' },
];

/**
 * Ads Manager → Audiences.
 *
 * Two tabs in the reference product, which map onto
 * `meta_ad_audiences.origin`: audiences we pushed up from CRM contacts
 * ('crm', refreshable because there is a local source) and ones that
 * already existed in the ad account ('meta', not refreshable).
 *
 * ⚠️ THE PRIVACY NOTE ON THIS SCREEN IS NOT DECORATION.
 *   Building an audience uploads customer phone numbers to Meta. They are
 *   SHA-256 hashed server-side before they leave the process
 *   (`hashAudienceIdentifier`), and the UI says so — a user pressing this
 *   button is making a data-sharing decision and deserves to know what is
 *   actually sent.
 */
export function AdsAudiences() {
  const { accountId } = useAuth();
  const canEdit = useCan('edit-settings');
  const [audiences, setAudiences] = useState<AdAudience[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [includeEmails, setIncludeEmails] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [lookalikeFrom, setLookalikeFrom] = useState('');
  const [lookalikeName, setLookalikeName] = useState('');
  const [country, setCountry] = useState('IN');
  const [ratio, setRatio] = useState('0.01');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ads/audiences', { cache: 'no-store' });
      if (!res.ok) throw new Error('Request failed');
      const json = (await res.json()) as { custom: AdAudience[] };
      setAudiences(json.custom);
    } catch {
      toast.error('Could not load audiences.');
      setAudiences([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Tags come straight from Supabase, matching how /contacts reads them —
  // there is no tags endpoint on the Nest API.
  //
  // ⚠️ Scoped explicitly. "RLS already scopes the query to this workspace" was
  // true until migration 095 and is now off by every other workspace the user
  // belongs to — and these tags build a Meta custom audience, so the wrong one
  // uploads another client's customers to this client's ad account.
  useEffect(() => {
    if (!accountId) return;
    void (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('tags')
        .select('id,name')
        .eq('account_id', accountId)
        .order('name');
      setTags((data as Tag[] | null) ?? []);
    })();
  }, [accountId]);

  async function refresh(audienceId: string) {
    setRefreshing(audienceId);
    try {
      const res = await fetch(
        `/api/ads/audiences/${encodeURIComponent(audienceId)}/refresh`,
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => null)) as {
        message?: string | string[];
        uploaded?: number;
        skipped?: number;
      } | null;

      if (!res.ok) {
        const message = Array.isArray(body?.message)
          ? body.message.join(', ')
          : body?.message;
        throw new Error(message ?? 'Could not refresh.');
      }

      toast.success(
        `Re-uploaded ${body?.uploaded ?? 0} contacts${
          body?.skipped ? `, skipped ${body.skipped}` : ''
        }.`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not refresh');
    } finally {
      setRefreshing(null);
    }
  }

  async function createFromContacts() {
    setBusy(true);
    try {
      const res = await fetch('/api/ads/audiences/from-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          tagIds: selectedTagIds.length ? selectedTagIds : undefined,
          includeEmails,
        }),
      });

      const body = (await res.json().catch(() => null)) as {
        message?: string | string[];
        uploaded?: number;
        skipped?: number;
        tooSmallForLookalike?: boolean;
      } | null;

      if (!res.ok) {
        const message = Array.isArray(body?.message)
          ? body.message.join(', ')
          : body?.message;
        throw new Error(message ?? 'Meta rejected the audience.');
      }

      // Report the skips, not just the successes: "uploaded 4,000 of 4,200"
      // is actionable; "uploaded" hides a data problem.
      toast.success(
        `Audience created with ${body?.uploaded ?? 0} contacts${
          body?.skipped
            ? `. ${body.skipped} were skipped — their phone numbers could not be used.`
            : '.'
        }`,
      );

      if (body?.tooSmallForLookalike) {
        toast.warning(
          'Meta usually needs about 100 matched people before it will build a lookalike from an audience.',
        );
      }

      setCreating(false);
      setName('');
      setSelectedTagIds([]);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create');
    } finally {
      setBusy(false);
    }
  }

  async function createLookalike() {
    setBusy(true);
    try {
      const res = await fetch('/api/ads/audiences/lookalike', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: lookalikeName,
          sourceAudienceId: lookalikeFrom,
          country,
          ratio: Number(ratio),
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string | string[];
        } | null;
        const message = Array.isArray(body?.message)
          ? body.message.join(', ')
          : body?.message;
        throw new Error(message ?? 'Meta rejected the lookalike.');
      }

      toast.success('Lookalike audience created. Meta will build it shortly.');
      setLookalikeFrom('');
      setLookalikeName('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create');
    } finally {
      setBusy(false);
    }
  }

  const seeds = (audiences ?? []).filter((a) => a.subtype === 'CUSTOM');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Audiences
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Target your existing customers, or people who look like them.
          </p>
        </div>
        {canEdit ? (
          <Button size="sm" onClick={() => setCreating((v) => !v)}>
            {creating ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
            {creating ? 'Cancel' : 'From my contacts'}
          </Button>
        ) : null}
      </header>

      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <p>
          Phone numbers are hashed (SHA-256) on our server before anything is
          sent to Meta, so Meta never receives a readable number — it can only
          match a hash against hashes it already holds. Only contacts in this
          workspace are ever included.
        </p>
      </div>

      {creating ? (
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">
            Build from your contacts
          </h2>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Audience name
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="All customers"
              maxLength={255}
            />
          </label>

          {tags.length > 0 ? (
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium text-foreground">
                Limit to contacts with these tags
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const on = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setSelectedTagIds((prev) =>
                          on
                            ? prev.filter((id) => id !== tag.id)
                            : [...prev, tag.id],
                        )
                      }
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs transition-colors',
                        on
                          ? 'border-primary bg-primary-soft text-primary'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {selectedTagIds.length === 0
                  ? 'No tags selected — every contact with a phone number is included.'
                  : 'Contacts with any of the selected tags.'}
              </p>
            </fieldset>
          ) : null}

          <label className="flex items-start gap-2 text-sm text-foreground">
            <Checkbox
              checked={includeEmails}
              onCheckedChange={(next) => setIncludeEmails(Boolean(next))}
            />
            <span>
              Also upload email addresses
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Improves matching for contacts Meta cannot find by phone.
                Emails are hashed the same way. Off by default because most
                contacts here have a phone number and few have an email.
              </span>
            </span>
          </label>

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !name.trim()}
              onClick={() => void createFromContacts()}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Create audience
            </Button>
          </div>
        </section>
      ) : null}

      {/* Lookalike, only offered once there is something to seed from. */}
      {canEdit && seeds.length > 0 ? (
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Copy className="size-4 text-muted-foreground" />
            Create a lookalike
          </h2>
          <p className="text-xs text-muted-foreground">
            Meta finds people who resemble an audience you already have.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Based on
              </span>
              <Select
                value={lookalikeFrom || null}
                onValueChange={(next) => {
                  if (typeof next === 'string') setLookalikeFrom(next);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a source audience" />
                </SelectTrigger>
                <SelectContent>
                  {seeds.map((audience) => (
                    <SelectItem key={audience.id} value={audience.id}>
                      {audience.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Name
              </span>
              <Input
                value={lookalikeName}
                onChange={(e) => setLookalikeName(e.target.value)}
                placeholder="Lookalike 1% — All customers"
                maxLength={255}
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Country
              </span>
              <Input
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                placeholder="IN"
                maxLength={2}
                className="w-20"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                A lookalike is grown within one country.
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Closeness
              </span>
              <Select
                value={ratio}
                onValueChange={(next) => {
                  if (typeof next === 'string') setRatio(next);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RATIOS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !lookalikeFrom || !lookalikeName.trim()}
              onClick={() => void createLookalike()}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Create lookalike
            </Button>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-border bg-card">
        {audiences === null ? (
          <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading audiences…
          </div>
        ) : audiences.length === 0 ? (
          <div className="p-8 text-center">
            <Users className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              No audiences on this ad account yet.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {audiences.map((audience) => (
              <li
                key={audience.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {audience.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {audience.subtype === 'LOOKALIKE'
                      ? 'Lookalike'
                      : audience.subtype === 'WEBSITE'
                        ? 'Website visitors'
                        : 'Customer list'}
                    {audience.deliveryStatus
                      ? ` · ${audience.deliveryStatus}`
                      : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className="text-xs tabular-nums text-muted-foreground"
                    title="Meta will not report an exact size below a privacy threshold"
                  >
                    ~{formatCompact(audience.approximateCount)} people
                  </span>
                  {/* Only a customer-list audience we built has a local
                      segment to rebuild from; a lookalike or an audience
                      that already existed in Meta does not. */}
                  {canEdit && audience.subtype === 'CUSTOM' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={refreshing === audience.id}
                      onClick={() => void refresh(audience.id)}
                      title="Re-upload this audience from your current contacts"
                    >
                      {refreshing === audience.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
