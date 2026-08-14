'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Gift,
  Globe,
  Loader2,
  MessageSquareReply,
  Plus,
  Send,
  Trash2,
  UserPlus,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  BUTTON_LABEL_CHARS,
  MAX_PUBLIC_REPLY_VARIANTS,
  MAX_REWARD_BUTTONS,
  MESSAGE_CHARS,
  REPLY_DELAY_OPTIONS,
  automationBody,
  validateAutomation,
} from '@/lib/instagram/automation';
import type { IgFunnelDraft, IgMedia } from '@/lib/instagram/types';
import { cn } from '@/lib/utils';

import { InstagramAutomationPreview } from './instagram-automation-preview';

/**
 * Whether the merchant is filtering on words or answering everything.
 *
 * A saved funnel stores only the consequence (`keywords`), so the mode has
 * to be re-inferred when one is opened — but from then on it is state the
 * merchant owns, not a function of the list. See the Segmented below.
 */
type TriggerMode = 'specific' | 'all';

function initialTriggerMode(draft: IgFunnelDraft | null): TriggerMode {
  return draft && draft.keywords.length > 0 ? 'specific' : 'all';
}

/**
 * Auto Reply to Comments — one post's automation, or the all-posts one.
 *
 * FULL SCREEN, ON PURPOSE
 *   This is the one screen in the Instagram area where a merchant writes
 *   copy that goes out under their own name, unattended, to people who
 *   have never messaged them. It gets the whole viewport: the preview on
 *   the left and the settings on the right, both scrolling independently,
 *   so proof-reading never costs a scroll away from the field being
 *   edited.
 *
 * ONE ROW UNDERNEATH
 *   "Automation" here is `instagram_comment_funnels` — the same row the
 *   Comment funnels page edits. The vocabulary differs because a merchant
 *   looking at a post is thinking "automate this post", not "create a
 *   funnel", but there is no second model and no mapping layer.
 *
 * NOTHING IS SENT UNTIL TWO SWITCHES AGREE
 *   `is_active` on the automation, and the account master switch. The
 *   footer says so when the second one is off, because otherwise
 *   publishing looks like it worked and then nothing happens.
 */
export function InstagramPostAutomation({
  open,
  draft: initial,
  media,
  username,
  masterEnabled,
  onOpenChange,
  onSaved,
  onDelete,
}: {
  open: boolean;
  /** The automation being edited. `id` absent = not saved yet. */
  draft: IgFunnelDraft | null;
  /** The post this automation is scoped to, or null for all posts. */
  media: IgMedia | null;
  username?: string | null;
  /** The account switch. False means nothing runs whatever this says. */
  masterEnabled: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void | Promise<void>;
  /** Absent for an unsaved draft — there is nothing to delete. */
  onDelete?: (id: string) => void | Promise<void>;
}) {
  const [form, setForm] = useState<IgFunnelDraft | null>(initial);
  const [saving, setSaving] = useState(false);
  const [keywordInput, setKeywordInput] = useState('');
  const [replyInput, setReplyInput] = useState('');
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(() =>
    initialTriggerMode(initial)
  );

  // A different automation is a different form. Keyed on identity rather
  // than a `key` prop on the caller so opening the same post twice does
  // not lose an in-progress edit to a re-render.
  useEffect(() => {
    setForm(initial);
    setTriggerMode(initialTriggerMode(initial));
    setKeywordInput('');
    setReplyInput('');
  }, [initial]);

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initial),
    [form, initial]
  );

  if (!form) return null;

  function set<K extends keyof IgFunnelDraft>(
    key: K,
    value: IgFunnelDraft[K]
  ) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  // Both appenders go through the functional updater rather than reading
  // the captured `form`. A blur and a click can land in the same tick —
  // typing a word then clicking "Any comment" fires both — and the
  // closure version would drop whichever update was built from the
  // staler snapshot.
  function addKeyword(raw: string) {
    const trimmed = raw.trim().replace(/,$/, '');
    setKeywordInput('');
    if (!trimmed) return;
    setForm((prev) => {
      if (!prev) return prev;
      // Case-insensitive: the server matches that way, so storing both
      // "Link" and "link" would show two chips that do the same thing.
      const exists = prev.keywords.some(
        (k) => k.toLowerCase() === trimmed.toLowerCase()
      );
      return exists ? prev : { ...prev, keywords: [...prev.keywords, trimmed] };
    });
  }

  function addReplyVariant(raw: string) {
    const trimmed = raw.trim();
    setReplyInput('');
    if (!trimmed) return;
    setForm((prev) => {
      if (!prev) return prev;
      if (prev.public_reply_texts.length >= MAX_PUBLIC_REPLY_VARIANTS)
        return prev;
      if (prev.public_reply_texts.includes(trimmed)) return prev;
      return {
        ...prev,
        public_reply_texts: [...prev.public_reply_texts, trimmed],
      };
    });
  }

  async function publish() {
    if (!form) return;
    // Anything the merchant abandoned is folded in first, so a stray
    // half-typed row cannot fail a save it was never part of.
    const problem = validateAutomation(form, {
      keywordsRequired: triggerMode === 'specific',
    });
    if (problem) {
      toast.error(problem);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(
        form.id ? `/api/instagram/funnels/${form.id}` : '/api/instagram/funnels',
        {
          method: form.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(automationBody(form)),
        }
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const message = Array.isArray(detail?.message)
          ? detail.message[0]
          : detail?.message;
        throw new Error(message || 'Could not save this automation.');
      }
      toast.success(
        form.is_active
          ? 'Automation published.'
          : 'Saved. Turn it on when you’re ready.'
      );
      // Closed before the refresh, not after: the save is done, and
      // holding a full-screen editor open while the grid re-reads its
      // funnels makes a finished action look like it is still going.
      onOpenChange(false);
      void onSaved();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save this automation.'
      );
    } finally {
      setSaving(false);
    }
  }

  function close() {
    if (
      dirty &&
      !window.confirm('Discard the changes to this automation?')
    ) {
      return;
    }
    onOpenChange(false);
  }

  const scoped = form.ig_media_id !== null;

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? null : close())}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        // Full viewport. The bottom variant already pins the x-axis and
        // the bottom edge, so `top-0` + `h-dvh` is what turns a drawer
        // into a page.
        className="inset-0 h-dvh max-w-none gap-0 rounded-none border-0 p-0"
      >
        <header className="border-border/60 bg-background flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
          <Button size="icon-sm" variant="ghost" onClick={close} aria-label="Close">
            <X className="size-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="text-foreground truncate text-sm font-semibold">
              Auto Reply to Comments
            </h2>
            <p className="text-muted-foreground truncate text-xs">
              {scoped ? form.name : 'Every post, present and future'}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {form.id && onDelete && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onDelete(form.id!)}
                title="Delete this automation"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" onClick={publish} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {form.is_active ? 'Publish' : 'Save'}
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          {/* Preview. Sticky on the desktop split so it stays beside
              whichever field is being edited. */}
          <div className="bg-muted/20 border-border/60 shrink-0 p-4 lg:w-[38%] lg:overflow-y-auto lg:border-r">
            <InstagramAutomationPreview
              draft={form}
              media={media}
              username={username}
              triggerMode={triggerMode}
            />
          </div>

          <div className="min-w-0 flex-1 space-y-4 p-4 lg:overflow-y-auto">
            {!scoped && (
              <Callout icon={Globe}>
                This runs on <strong>every post</strong>, including ones you
                haven’t published yet. A post with its own automation uses that
                one instead.
              </Callout>
            )}

            {/* ---------------- Trigger ---------------- */}
            <Section icon={Zap} title="Trigger">
              <p className="text-muted-foreground text-xs">
                Which comments start this. Matched anywhere in the comment and
                case-insensitively, so “LINK please” matches “link”.
              </p>

              {/* Held in state, NOT derived from keywords.length. Derived,
                  "Specific words" could not be selected until a word had
                  already been typed — the click resolved back to the same
                  value and the button never moved, which reads as a dead
                  control. The mode is the merchant's intent; the list is
                  what they do about it. */}
              <Segmented
                value={triggerMode}
                options={[
                  { value: 'specific', label: 'Specific words' },
                  { value: 'all', label: 'Any comment' },
                ]}
                onChange={(value) => {
                  const mode = value as TriggerMode;
                  setTriggerMode(mode);
                  // Leaving "specific" drops the words. Keeping them would
                  // mean a funnel that says "any comment" but still filters.
                  if (mode === 'all') {
                    set('keywords', []);
                    setKeywordInput('');
                  }
                }}
              />

              {triggerMode === 'specific' ? (
                <div className="space-y-2">
                  <ChipList
                    items={form.keywords}
                    onRemove={(index) =>
                      set(
                        'keywords',
                        form.keywords.filter((_, i) => i !== index)
                      )
                    }
                  />
                  <Input
                    value={keywordInput}
                    placeholder="Type a word and press Enter"
                    onChange={(e) => setKeywordInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        addKeyword(keywordInput);
                      }
                    }}
                    onBlur={() => addKeyword(keywordInput)}
                  />
                  {form.keywords.length === 0 && (
                    <p className="text-muted-foreground text-xs">
                      No words yet — add at least one, or switch to “Any
                      comment”.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Every comment on this post will be answered.
                </p>
              )}
            </Section>

            {/* ---------------- Public reply ---------------- */}
            <Section
              icon={MessageSquareReply}
              title="Reply under the comment"
              toggle={{
                checked: form.public_reply_texts.length > 0,
                onChange: (next) =>
                  set(
                    'public_reply_texts',
                    next ? ['Check your DMs 📩'] : []
                  ),
              }}
            >
              <p className="text-muted-foreground text-xs">
                Public, so everyone else reading the comments sees that
                something happened — which is most of why this pattern works.
              </p>

              {form.public_reply_texts.length > 0 && (
                <>
                  <ChipList
                    items={form.public_reply_texts}
                    onRemove={(index) =>
                      set(
                        'public_reply_texts',
                        form.public_reply_texts.filter((_, i) => i !== index)
                      )
                    }
                  />
                  {form.public_reply_texts.length <
                    MAX_PUBLIC_REPLY_VARIANTS && (
                    <Input
                      value={replyInput}
                      placeholder="Add another wording and press Enter"
                      onChange={(e) => setReplyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addReplyVariant(replyInput);
                        }
                      }}
                      onBlur={() => addReplyVariant(replyInput)}
                    />
                  )}
                  <p className="text-muted-foreground text-xs">
                    {form.public_reply_texts.length > 1
                      ? `Rotated one at a time across ${form.public_reply_texts.length} wordings.`
                      : 'Add a second wording — a post with hundreds of identical replies is what Instagram’s spam filter looks for.'}
                  </p>
                </>
              )}
            </Section>

            {/* ---------------- The opening DM ---------------- */}
            <Section icon={Send} title="The opening DM">
              <p className="text-muted-foreground text-xs">
                Instagram won’t tell us whether someone follows you until
                they’ve messaged you first — a comment doesn’t count. This
                message and its button exist to get that first tap, which is
                what makes everything below possible. It can’t be skipped.
              </p>

              <Field label="Message" hint={`${form.optin_text.length}/${MESSAGE_CHARS}`}>
                <Textarea
                  rows={3}
                  maxLength={MESSAGE_CHARS}
                  value={form.optin_text}
                  onChange={(e) => set('optin_text', e.target.value)}
                />
              </Field>

              <Field
                label="Button"
                hint={`${form.optin_button_label.length}/${BUTTON_LABEL_CHARS}`}
              >
                <Input
                  maxLength={BUTTON_LABEL_CHARS}
                  value={form.optin_button_label}
                  onChange={(e) => set('optin_button_label', e.target.value)}
                />
              </Field>
            </Section>

            {/* ---------------- Follow ask ---------------- */}
            <Section
              icon={UserPlus}
              title="Ask them to follow first"
              toggle={{
                checked: form.follow_gate_enabled,
                onChange: (next) => set('follow_gate_enabled', next),
              }}
            >
              <p className="text-muted-foreground text-xs">
                Only shown to people who don’t already follow you. The link is
                sent either way when they tap — asking is a nudge, not a gate,
                so a slow-to-update follow status never costs you the lead.
              </p>

              {form.follow_gate_enabled && (
                <>
                  <Field label="Message">
                    <Textarea
                      rows={3}
                      maxLength={MESSAGE_CHARS}
                      value={form.follow_ask_text ?? ''}
                      onChange={(e) => set('follow_ask_text', e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Button"
                    hint={`${form.follow_button_label.length}/${BUTTON_LABEL_CHARS}`}
                  >
                    <Input
                      maxLength={BUTTON_LABEL_CHARS}
                      value={form.follow_button_label}
                      onChange={(e) =>
                        set('follow_button_label', e.target.value)
                      }
                    />
                  </Field>
                </>
              )}
            </Section>

            {/* ---------------- Reward ---------------- */}
            <Section icon={Gift} title="Send the link">
              <Field label="Message" hint={`${form.reward_text.length}/${MESSAGE_CHARS}`}>
                <Textarea
                  rows={3}
                  maxLength={MESSAGE_CHARS}
                  value={form.reward_text}
                  onChange={(e) => set('reward_text', e.target.value)}
                />
              </Field>

              <div className="space-y-2">
                <Label>Link buttons</Label>
                {(form.reward_buttons ?? []).map((button, i) => (
                  <div key={i} className="flex flex-wrap gap-2">
                    <Input
                      className="w-36"
                      maxLength={BUTTON_LABEL_CHARS}
                      placeholder="Click here!"
                      value={button.label}
                      onChange={(e) =>
                        set(
                          'reward_buttons',
                          (form.reward_buttons ?? []).map((b, j) =>
                            j === i ? { ...b, label: e.target.value } : b
                          )
                        )
                      }
                    />
                    <Input
                      className="min-w-44 flex-1"
                      placeholder="https://…"
                      value={button.url}
                      onChange={(e) =>
                        set(
                          'reward_buttons',
                          (form.reward_buttons ?? []).map((b, j) =>
                            j === i ? { ...b, url: e.target.value } : b
                          )
                        )
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Remove this button"
                      onClick={() =>
                        set(
                          'reward_buttons',
                          (form.reward_buttons ?? []).filter((_, j) => j !== i)
                        )
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
                {(form.reward_buttons ?? []).length < MAX_REWARD_BUTTONS && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      set('reward_buttons', [
                        ...(form.reward_buttons ?? []),
                        { label: '', url: '' },
                      ])
                    }
                  >
                    <Plus className="size-4" />
                    Add button
                  </Button>
                )}
                <p className="text-muted-foreground text-xs">
                  Up to {MAX_REWARD_BUTTONS} — Instagram won’t render more.
                  Leave them empty to send the message on its own.
                </p>
              </div>
            </Section>

            {/* ---------------- Delay ---------------- */}
            <Section icon={Clock} title="Reply delay">
              <p className="text-muted-foreground text-xs">
                Answering within a second is the tell that a robot did it. A
                short wait reads like a person who saw the notification.
              </p>
              <Segmented
                value={String(form.reply_delay_seconds)}
                options={REPLY_DELAY_OPTIONS.map((option) => ({
                  value: String(option.value),
                  label: option.label,
                }))}
                onChange={(value) => set('reply_delay_seconds', Number(value))}
              />
            </Section>

            {/* ---------------- Name + arm ---------------- */}
            <Section title="This automation">
              <Field label="Name">
                <Input
                  value={form.name}
                  placeholder="Reel — AI Creator Lab"
                  onChange={(e) => set('name', e.target.value)}
                />
              </Field>

              <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <Label htmlFor="automation-active">Run this automation</Label>
                  <p className="text-muted-foreground mt-1 text-xs">
                    New automations start off. Turn it on once the wording reads
                    the way you want — the first DM is not something you can
                    take back.
                  </p>
                </div>
                <Switch
                  id="automation-active"
                  checked={form.is_active}
                  onCheckedChange={(next) => set('is_active', next === true)}
                />
              </div>

              {form.is_active && !masterEnabled && (
                <Callout icon={AlertTriangle} tone="warning">
                  Comment automations are switched off for the whole account, so
                  this won’t run yet. The master switch is on the Posts page.
                </Callout>
              )}
            </Section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ============================================================
// Layout pieces
// ============================================================

function Section({
  icon: Icon,
  title,
  toggle,
  children,
}: {
  icon?: typeof Zap;
  title: string;
  /** Present makes the section's own switch its header control. */
  toggle?: { checked: boolean; onChange: (next: boolean) => void };
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-card space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="text-muted-foreground size-4" />}
          <h3 className="text-foreground text-sm font-medium">{title}</h3>
        </div>
        {toggle && (
          <Switch
            checked={toggle.checked}
            onCheckedChange={(next) => toggle.onChange(next === true)}
            aria-label={title}
          />
        )}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  /** Right-aligned counter or note, alongside the label. */
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label>{label}</Label>
        {hint && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Two-or-three-way choice as one control.
 *
 * Not a Select: these are binary-ish choices where seeing the
 * alternative matters, and a closed dropdown hides the fact that "Any
 * comment" is even an option.
 */
function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="border-border bg-muted/40 inline-flex flex-wrap gap-1 rounded-lg border p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition-colors',
            value === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Removable pills for keyword and reply-variant lists. */
function ChipList({
  items,
  onRemove,
}: {
  items: readonly string[];
  onRemove: (index: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>
          <Badge variant="outline" className="h-auto max-w-full gap-1 py-1">
            <span className="truncate">{item}</span>
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`Remove ${item}`}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <X className="size-3" />
            </button>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function Callout({
  icon: Icon,
  tone = 'info',
  children,
}: {
  icon: typeof Globe;
  tone?: 'info' | 'warning';
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-xs',
        tone === 'warning'
          ? 'border-amber-500/30 bg-amber-500/10 text-accent-amber'
          : 'border-border bg-muted/40 text-muted-foreground'
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0">{children}</p>
    </div>
  );
}
