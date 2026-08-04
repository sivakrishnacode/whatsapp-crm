'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Gift,
  Loader2,
  MessageSquareReply,
  Plus,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

import { REPLY_DELAY_OPTIONS } from '@/lib/instagram/automation';
import type { IgFunnel, IgFunnelDraft } from '@/lib/instagram/types';

type Funnel = IgFunnel;
type Draft = IgFunnelDraft;

const BLANK: Draft = {
  name: '',
  ig_media_id: null,
  keywords: [],
  optin_text: "Yo! I need to check you aren't a bot, so tap below ✨",
  optin_button_label: "I'm ready 🙂",
  follow_gate_enabled: true,
  follow_ask_text:
    "Oh no! You aren't following, so the link won't send ✨ Make sure you're following and I'll send it over 🎉",
  follow_button_label: 'I followed you! ✅',
  reward_text: "🎁 Awesome! Here's everything you need!",
  reward_buttons: [{ label: 'Click here!', url: '' }],
  public_reply_texts: ['Check your DMs 📩'],
  reply_delay_seconds: 0,
  is_active: false,
};

/**
 * Comment → DM funnels.
 *
 * TWO SWITCHES ON PURPOSE
 *   The master toggle at the top stops every funnel at once; each
 *   funnel then has its own. A feature that DMs strangers on the
 *   business's behalf needs one lever that halts everything without the
 *   merchant having to remember which funnels were on so they can put
 *   them back afterwards.
 *
 * WHY THE FIRST MESSAGE CANNOT BE SKIPPED
 *   It reads like a growth-hack tic, and the UI says so plainly,
 *   because merchants will otherwise try to delete it. Meta will not
 *   answer "does this person follow you?" for someone who has only
 *   commented — a comment is not consent. The opening button exists to
 *   produce the first inbound message, which is what unlocks the
 *   lookup. Without it the follow gate cannot be evaluated at all.
 */
export function InstagramFunnels() {
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    try {
      const [listRes, enabledRes] = await Promise.all([
        fetch('/api/instagram/funnels', { cache: 'no-store' }),
        fetch('/api/instagram/funnels/enabled', { cache: 'no-store' }),
      ]);
      const list = await listRes.json();
      const flag = await enabledRes.json();
      setFunnels(list.funnels ?? []);
      setEnabled(flag.enabled ?? false);
      setConnected(flag.connected ?? false);
    } catch {
      toast.error('Could not load comment funnels.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleMaster(next: boolean) {
    // Optimistic, then reconciled by load(). The switch is the one
    // control a merchant may reach for in a hurry.
    setEnabled(next);
    try {
      const res = await fetch('/api/instagram/funnels/enabled', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
      toast.success(
        next ? 'Comment funnels are live.' : 'Comment funnels paused.'
      );
    } catch (err) {
      setEnabled(!next);
      toast.error(
        err instanceof Error ? err.message : 'Could not change the setting.'
      );
    }
  }

  async function toggleFunnel(funnel: Funnel, next: boolean) {
    setFunnels((prev) =>
      prev.map((f) => (f.id === funnel.id ? { ...f, is_active: next } : f))
    );
    try {
      const res = await fetch(`/api/instagram/funnels/${funnel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
    } catch (err) {
      void load();
      toast.error(
        err instanceof Error ? err.message : 'Could not change the funnel.'
      );
    }
  }

  async function remove(funnel: Funnel) {
    if (!confirm(`Delete “${funnel.name}”? Its history goes too.`)) return;
    try {
      const res = await fetch(`/api/instagram/funnels/${funnel.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Delete failed');
      setFunnels((prev) => prev.filter((f) => f.id !== funnel.id));
      toast.success('Funnel deleted.');
    } catch {
      toast.error('Could not delete the funnel.');
    }
  }

  if (editing) {
    return (
      <FunnelEditor
        draft={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-lg font-semibold">
            Comment funnels
          </h1>
          <p className="text-muted-foreground text-sm">
            Someone comments on a post, and gets the link in their DMs.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({ ...BLANK })}>
          <Plus className="size-4" />
          New funnel
        </Button>
      </div>

      <div className="border-border bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <div>
          <Label htmlFor="funnels-enabled" className="text-foreground text-sm">
            Comment funnels
          </Label>
          <p className="text-muted-foreground mt-1 text-xs">
            {connected
              ? 'The master switch. Off means no funnel runs, whatever its own setting says.'
              : 'Connect Instagram before turning this on.'}
          </p>
        </div>
        <Switch
          id="funnels-enabled"
          checked={enabled}
          disabled={!connected}
          onCheckedChange={toggleMaster}
        />
      </div>

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 p-8 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading funnels…
        </div>
      ) : funnels.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed p-10 text-center">
          <Gift className="text-muted-foreground mx-auto size-8" />
          <p className="text-foreground mt-3 text-sm font-medium">
            No funnels yet
          </p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
            The classic one: post a Reel, say &ldquo;comment{' '}
            <strong>LINK</strong> and I&rsquo;ll send it&rdquo;, and let this
            handle the rest.
          </p>
          <Button
            className="mt-4"
            size="sm"
            onClick={() => setEditing({ ...BLANK })}
          >
            <Plus className="size-4" />
            Create a funnel
          </Button>
        </div>
      ) : (
        <ul className="space-y-3">
          {funnels.map((funnel) => (
            <li
              key={funnel.id}
              className="border-border bg-card rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-foreground truncate text-sm font-medium">
                    {funnel.name}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {funnel.ig_media_id ? 'One post' : 'All posts'}
                    {' · '}
                    {funnel.keywords.length > 0
                      ? funnel.keywords.join(', ')
                      : 'any comment'}
                    {funnel.follow_gate_enabled ? ' · asks for a follow' : ''}
                  </p>
                  <p className="text-muted-foreground mt-2 text-xs">
                    {funnel.matched_count} started ·{' '}
                    <strong className="text-foreground">
                      {funnel.delivered_count} delivered
                    </strong>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={funnel.is_active}
                    onCheckedChange={(next) => toggleFunnel(funnel, next)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditing({
                        ...funnel,
                        reward_buttons: funnel.reward_buttons ?? [],
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(funnel)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              {funnel.is_active && !enabled && (
                <p className="text-muted-foreground mt-3 text-xs">
                  Active, but the master switch above is off — this is not
                  running.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// Editor
// ============================================================

function FunnelEditor({
  draft,
  onCancel,
  onSaved,
}: {
  draft: Draft;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Draft>(draft);
  const [saving, setSaving] = useState(false);

  // `reward_buttons` is nullable on the wire (a row written before the
  // column had a default), and the editor treats it as a list throughout.
  const rewardButtons = form.reward_buttons ?? [];

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        name: form.name,
        ig_media_id: form.ig_media_id || null,
        keywords: form.keywords,
        optin_text: form.optin_text,
        optin_button_label: form.optin_button_label,
        follow_gate_enabled: form.follow_gate_enabled,
        follow_ask_text: form.follow_ask_text || null,
        follow_button_label: form.follow_button_label,
        reward_text: form.reward_text,
        // Half-typed rows are dropped rather than sent — the API rejects
        // a blank URL, and losing the whole save to one empty row the
        // merchant had already abandoned is a miserable way to find out.
        reward_buttons: rewardButtons.filter(
          (b) => b.label.trim() && b.url.trim()
        ),
        public_reply_texts: form.public_reply_texts
          .map((t) => t.trim())
          .filter(Boolean),
        reply_delay_seconds: form.reply_delay_seconds,
        is_active: form.is_active,
      };

      const res = await fetch(
        form.id ? `/api/instagram/funnels/${form.id}` : '/api/instagram/funnels',
        {
          method: form.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const message = Array.isArray(detail?.message)
          ? detail.message[0]
          : detail?.message;
        throw new Error(message || 'Could not save the funnel.');
      }
      toast.success('Funnel saved.');
      onSaved();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save the funnel.'
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-foreground text-lg font-semibold">
            {form.id ? 'Edit funnel' : 'New funnel'}
          </h1>
        </div>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save funnel
        </Button>
      </div>

      {/* ---------------- Scope ---------------- */}
      <section className="border-border bg-card space-y-4 rounded-xl border p-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={form.name}
            placeholder="Reel — AI Creator Lab"
            onChange={(e) => set('name', e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="media">Post ID</Label>
          <Input
            id="media"
            value={form.ig_media_id ?? ''}
            placeholder="Leave blank for every post"
            onChange={(e) => set('ig_media_id', e.target.value || null)}
          />
          <p className="text-muted-foreground text-xs">
            Copy it from the Posts page. A funnel for one post beats a
            leave-it-on-everything funnel, so both can run at once.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="keywords">Keywords</Label>
          <Input
            id="keywords"
            value={form.keywords.join(', ')}
            placeholder="link, send, info"
            onChange={(e) =>
              set(
                'keywords',
                e.target.value
                  .split(',')
                  .map((k) => k.trim())
                  .filter(Boolean)
              )
            }
          />
          <p className="text-muted-foreground text-xs">
            Comma-separated, case-insensitive, matched anywhere in the comment.
            Leave blank to reply to every comment on the post.
          </p>
        </div>
      </section>

      {/* ---------------- Step 1 ---------------- */}
      <section className="border-border bg-card space-y-4 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <MessageSquareReply className="text-muted-foreground size-4" />
          <h2 className="text-foreground text-sm font-medium">
            1 · The opening DM
          </h2>
        </div>
        <p className="text-muted-foreground text-xs">
          Instagram won&rsquo;t tell us whether someone follows you until
          they&rsquo;ve messaged you first — a comment doesn&rsquo;t count. This
          message and its button exist to get that first tap, which is what
          makes everything below possible.
        </p>

        <div className="space-y-2">
          <Label htmlFor="optin">Message</Label>
          <Textarea
            id="optin"
            rows={3}
            value={form.optin_text}
            onChange={(e) => set('optin_text', e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="optin-btn">Button</Label>
          <Input
            id="optin-btn"
            maxLength={20}
            value={form.optin_button_label}
            onChange={(e) => set('optin_button_label', e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Instagram caps button labels at 20 characters.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="public-reply">Public replies (optional)</Label>
          <Input
            id="public-reply"
            value={form.public_reply_texts.join(' | ')}
            placeholder="Check your DMs 📩 | Sent ✅ | DMed you!"
            onChange={(e) =>
              set(
                'public_reply_texts',
                e.target.value
                  .split('|')
                  .map((t) => t.trim())
                  .filter(Boolean)
              )
            }
          />
          <p className="text-muted-foreground text-xs">
            Posted under the post as a normal reply. Everyone else reading the
            comments sees it, which is most of why this pattern works.
            Pipe-separated — several wordings are rotated one per comment, so a
            busy post is not carrying a hundred identical replies.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Reply delay</Label>
          <div className="flex flex-wrap gap-2">
            {REPLY_DELAY_OPTIONS.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={
                  form.reply_delay_seconds === option.value
                    ? 'secondary'
                    : 'outline'
                }
                onClick={() => set('reply_delay_seconds', option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            Answering within a second is the tell that a robot did it.
          </p>
        </div>
      </section>

      {/* ---------------- Step 2 ---------------- */}
      <section className="border-border bg-card space-y-4 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <UserPlus className="text-muted-foreground size-4" />
            <h2 className="text-foreground text-sm font-medium">
              2 · Ask for a follow
            </h2>
          </div>
          <Switch
            checked={form.follow_gate_enabled}
            onCheckedChange={(next) => set('follow_gate_enabled', next)}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          Only shown to people who don&rsquo;t already follow you. The link is
          sent either way when they tap — asking is a nudge, not a gate, so a
          slow-to-update follow status never costs you the lead.
        </p>

        {form.follow_gate_enabled && (
          <>
            <div className="space-y-2">
              <Label htmlFor="follow-ask">Message</Label>
              <Textarea
                id="follow-ask"
                rows={3}
                value={form.follow_ask_text ?? ''}
                onChange={(e) => set('follow_ask_text', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="follow-btn">Button</Label>
              <Input
                id="follow-btn"
                maxLength={20}
                value={form.follow_button_label}
                onChange={(e) => set('follow_button_label', e.target.value)}
              />
            </div>
          </>
        )}
      </section>

      {/* ---------------- Step 3 ---------------- */}
      <section className="border-border bg-card space-y-4 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Gift className="text-muted-foreground size-4" />
          <h2 className="text-foreground text-sm font-medium">
            3 · The reward
          </h2>
        </div>

        <div className="space-y-2">
          <Label htmlFor="reward">Message</Label>
          <Textarea
            id="reward"
            rows={3}
            value={form.reward_text}
            onChange={(e) => set('reward_text', e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label>Link buttons</Label>
          {rewardButtons.map((button, i) => (
            <div key={i} className="flex flex-wrap gap-2">
              <Input
                className="w-40"
                maxLength={20}
                placeholder="Click here!"
                value={button.label}
                onChange={(e) =>
                  set(
                    'reward_buttons',
                    rewardButtons.map((b, j) =>
                      j === i ? { ...b, label: e.target.value } : b
                    )
                  )
                }
              />
              <Input
                className="min-w-48 flex-1"
                placeholder="https://…"
                value={button.url}
                onChange={(e) =>
                  set(
                    'reward_buttons',
                    rewardButtons.map((b, j) =>
                      j === i ? { ...b, url: e.target.value } : b
                    )
                  )
                }
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  set(
                    'reward_buttons',
                    rewardButtons.filter((_, j) => j !== i)
                  )
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          {rewardButtons.length < 3 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                set('reward_buttons', [
                  ...rewardButtons,
                  { label: '', url: '' },
                ])
              }
            >
              <Plus className="size-4" />
              Add button
            </Button>
          )}
          <p className="text-muted-foreground text-xs">
            Up to 3 — Instagram won&rsquo;t render more. Leave them all empty to
            send the message on its own.
          </p>
        </div>
      </section>

      {/* ---------------- Arm ---------------- */}
      <section className="border-border bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <div>
          <Label htmlFor="is-active">Run this funnel</Label>
          <p className="text-muted-foreground mt-1 text-xs">
            New funnels start off. Turn it on once the wording reads the way you
            want it to — the first DM is not something you can take back.
          </p>
        </div>
        <Switch
          id="is-active"
          checked={form.is_active}
          onCheckedChange={(next) => set('is_active', next)}
        />
      </section>
    </div>
  );
}
