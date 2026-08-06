'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Building2, Loader2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { ROLE_META } from './role-meta';
import { SettingsChip } from './settings-chip';

/** Matches MAX_NAME_LEN in the API's PATCH /account handler. */
const MAX_NAME_LEN = 80;

/**
 * "Which workspace am I in, and as what?" — on the profile screen,
 * because that is the question people bring to their profile.
 *
 * It is also the only place the account can be renamed. `PATCH
 * /api/account` has existed since the account-sharing work but had no UI
 * at all: the name was whatever the signup trigger derived from the
 * owner's full name, and it shows up in the header, the rail and every
 * invite. Admin+ can fix it here, matching the endpoint's own bar —
 * asking the server would just 403 for anyone lower.
 *
 * Deliberately NOT inside ProfileForm's <form>: nesting forms is invalid
 * HTML, and these save independently anyway — renaming the workspace has
 * nothing to do with changing your own avatar.
 */
export function WorkspaceCard() {
  const { account, accountRole, canManageMembers, refreshProfile } = useAuth();

  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(account?.name ?? '');
  }, [account?.name]);

  const roleMeta = accountRole ? ROLE_META[accountRole] : null;
  const RoleIcon = roleMeta?.icon;

  const trimmed = name.trim();
  const dirty = !!account && trimmed.length > 0 && trimmed !== account.name;

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || saving) return;

    setSaving(true);
    try {
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Failed to rename (${res.status})`);
      }

      // Re-reads profile *and* account, so the header chip and the rail
      // footer pick the new name up without a reload.
      await refreshProfile();
      toast.success('Workspace renamed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to rename');
      setName(account?.name ?? '');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-4">
      <CardContent className="space-y-6">
        <div className="flex items-center gap-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Building2 className="size-5 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-foreground">
              {account?.name ?? 'Your workspace'}
            </div>
            <div className="text-sm text-muted-foreground">
              {canManageMembers
                ? 'Shared by everyone you invite'
                : 'You were invited to this workspace'}
            </div>
          </div>
          {roleMeta && RoleIcon ? (
            <SettingsChip variant={roleMeta.variant}>
              <RoleIcon />
              {roleMeta.label}
            </SettingsChip>
          ) : null}
        </div>

        {canManageMembers ? (
          <form onSubmit={onSave} className="space-y-2">
            <Label htmlFor="workspace-name" className="text-foreground">
              Workspace name
            </Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Retail"
                maxLength={MAX_NAME_LEN}
                disabled={saving || !account}
                className="min-w-48 flex-1"
              />
              <Button type="submit" disabled={!dirty || saving}>
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  'Rename'
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Shown in the header, the sidebar and on every invitation you
              send.
            </p>
          </form>
        ) : null}

        <div className="rounded-lg border border-border bg-muted p-4">
          <p className="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Workspace details
          </p>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Your role</dt>
              <dd className="mt-0.5 text-foreground">
                {roleMeta?.label ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Default currency</dt>
              <dd className="mt-0.5 font-mono text-foreground">
                {account?.default_currency ?? '—'}
              </dd>
            </div>
            <div className="sm:col-span-2">
              {/* Support asks for this by name when tracing an account. */}
              <dt className="text-muted-foreground">Workspace ID</dt>
              <dd className="mt-0.5 font-mono text-xs break-all text-muted-foreground">
                {account?.id ?? '—'}
              </dd>
            </div>
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}
