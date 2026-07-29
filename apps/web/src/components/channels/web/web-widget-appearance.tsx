'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface Appearance {
  accent: string;
  position: 'left' | 'right';
  theme: 'light' | 'dark' | 'auto';
  launcher_icon: string;
  title: string;
  subtitle: string;
  greeting: string | null;
  teaser: string | null;
  teaser_delay_seconds: number;
}

interface WebStatus {
  widget_key: string;
  appearance: Appearance;
  ai_enabled: boolean;
  show_branding: boolean;
  locale: string;
}

/**
 * Appearance editor with a live preview.
 *
 * The preview is the real widget in a real iframe, not a mock-up. A
 * hand-drawn approximation drifts from the shipped widget the moment either
 * changes, and the whole reason someone is on this page is to know what
 * their visitors will see.
 */
export function WebWidgetAppearance() {
  const [status, setStatus] = useState<WebStatus | null>(null);
  const [draft, setDraft] = useState<Appearance | null>(null);
  const [branding, setBranding] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Bumped on save to force the preview iframe to re-fetch its bootstrap;
  // it reads appearance from the API, not from this component's state.
  const [previewNonce, setPreviewNonce] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/web/config', { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as WebStatus;
      setStatus(data);
      setDraft(data.appearance);
      setBranding(data.show_branding);
      setAiEnabled(data.ai_enabled);
    } catch {
      toast.error('Could not load the widget appearance.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await fetch('/api/web/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appearance: draft,
          show_branding: branding,
          ai_enabled: aiEnabled,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? 'Save failed');
      }
      const data = (await res.json()) as WebStatus;
      setStatus(data);
      setDraft(data.appearance);
      setPreviewNonce((n) => n + 1);
      toast.success('Appearance saved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading widget appearance…
      </div>
    );
  }

  if (!status || !draft) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        Could not load the widget appearance. Reload the page to try again.
      </p>
    );
  }

  const set = <K extends keyof Appearance>(key: K, value: Appearance[K]) =>
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(status.appearance) ||
    branding !== status.show_branding ||
    aiEnabled !== status.ai_enabled;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-6">
        <section className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Look</p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="accent">Accent colour</Label>
              <div className="flex gap-2">
                <input
                  id="accent"
                  type="color"
                  value={draft.accent}
                  onChange={(e) => set('accent', e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded-md border border-border bg-transparent p-1"
                />
                <Input
                  value={draft.accent}
                  onChange={(e) => set('accent', e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Position</Label>
              <Select
                value={draft.position}
                onValueChange={(v) => set('position', v as 'left' | 'right')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="right">Bottom right</SelectItem>
                  <SelectItem value="left">Bottom left</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Colour mode</Label>
              <Select
                value={draft.theme}
                onValueChange={(v) =>
                  set('theme', v as 'light' | 'dark' | 'auto')
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Match the visitor’s device</SelectItem>
                  <SelectItem value="light">Always light</SelectItem>
                  <SelectItem value="dark">Always dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Words</p>

          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="title">Header title</Label>
              <Input
                id="title"
                value={draft.title}
                maxLength={80}
                onChange={(e) => set('title', e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="subtitle">Header subtitle</Label>
              <Input
                id="subtitle"
                value={draft.subtitle}
                maxLength={160}
                onChange={(e) => set('subtitle', e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Set an honest expectation here — “usually replies in a few
                hours” beats “replies instantly” if you don’t.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="greeting">Opening message</Label>
              <Textarea
                id="greeting"
                value={draft.greeting ?? ''}
                maxLength={500}
                rows={2}
                onChange={(e) => set('greeting', e.target.value || null)}
                placeholder="Hi! How can we help?"
              />
              <p className="text-xs text-muted-foreground">
                Shown inside the chat before anyone types. Does not create a
                conversation.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="teaser">Teaser bubble</Label>
              <Input
                id="teaser"
                value={draft.teaser ?? ''}
                maxLength={160}
                onChange={(e) => set('teaser', e.target.value || null)}
                placeholder="Questions? We’re here."
              />
              <div className="flex items-center gap-2 pt-1">
                <Label
                  htmlFor="teaser-delay"
                  className="text-xs font-normal text-muted-foreground"
                >
                  Appears after
                </Label>
                <Input
                  id="teaser-delay"
                  type="number"
                  min={0}
                  max={600}
                  value={draft.teaser_delay_seconds}
                  onChange={(e) =>
                    set('teaser_delay_seconds', Number(e.target.value) || 0)
                  }
                  className="h-8 w-20"
                />
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Behaviour</p>

          <div className="mt-4 space-y-4">
            <ToggleRow
              label="AI replies"
              hint="Let the AI assistant answer when no automation or flow does. Uses your knowledge base."
              checked={aiEnabled}
              onChange={setAiEnabled}
            />
            <ToggleRow
              label="Show “Powered by Converse360”"
              hint="Removing the badge requires a paid plan."
              checked={branding}
              onChange={setBranding}
            />
          </div>
        </section>

        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save changes
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(status.appearance);
                setBranding(status.show_branding);
                setAiEnabled(status.ai_enabled);
              }}
            >
              <RotateCcw className="size-4" />
              Discard
            </Button>
          )}
        </div>
      </div>

      <WidgetPreview
        widgetKey={status.widget_key}
        nonce={previewNonce}
        dirty={dirty}
      />
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * The real widget, framed.
 *
 * Only the saved state is previewable: the frame reads its appearance from
 * `GET /public/web/bootstrap`, so unsaved edits are not visible until saved.
 * Saying so is better than silently showing stale colours next to a form the
 * user just changed.
 */
function WidgetPreview({
  widgetKey,
  nonce,
  dirty,
}: {
  widgetKey: string;
  nonce: number;
  dirty: boolean;
}) {
  return (
    <div className="lg:sticky lg:top-6 lg:self-start">
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">Live preview</p>
          {dirty && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              Save to update
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          The actual widget, exactly as a visitor sees it.
        </p>

        <div
          className={cn(
            'mt-3 overflow-hidden rounded-lg border border-border bg-muted/30',
            dirty && 'opacity-70',
          )}
        >
          <iframe
            // `nonce` in the key forces a remount on save; changing only the
            // src query would not re-run the frame's bootstrap fetch.
            key={nonce}
            src={`/widget/v1/frame?key=${encodeURIComponent(widgetKey)}&view=panel&preview=1`}
            title="Widget preview"
            className="h-[560px] w-full border-0"
          />
        </div>
      </div>
    </div>
  );
}
