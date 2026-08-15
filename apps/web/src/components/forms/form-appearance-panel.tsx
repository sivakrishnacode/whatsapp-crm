'use client';

/**
 * The Appearance tab: how the hosted form looks, with a live preview.
 *
 * The preview is the REAL `FormSurface` wrapping the REAL `FormRenderer`,
 * for the same reason the builder canvas renders real fields — a mock-up
 * of your own product's output is a promise you have to keep by hand.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  ACCENT_PRESETS,
  DEFAULT_FORM_THEME,
  resolveFormTheme,
  safeAccent,
  type FormColorScheme,
  type FormHeaderStyle,
  type FormTheme,
} from '@/lib/forms/theme';
import type { FormBuilderField } from '@/lib/forms/field-types';
import FormRenderer from './form-renderer';
import FormSurface from './form-surface';

const SCHEMES: {
  value: FormColorScheme;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
}[] = [
  { value: 'light', label: 'Light', icon: Sun, hint: 'Always light' },
  { value: 'dark', label: 'Dark', icon: Moon, hint: 'Always dark' },
  {
    value: 'system',
    label: 'Match visitor',
    icon: Monitor,
    hint: "Follows the visitor's device",
  },
];

const HEADERS: { value: FormHeaderStyle; label: string; hint: string }[] = [
  { value: 'gradient', label: 'Gradient', hint: 'Colour wash banner' },
  { value: 'solid', label: 'Solid', hint: 'Flat colour banner' },
  { value: 'bar', label: 'Accent bar', hint: 'Thin rule, plain title' },
  { value: 'none', label: 'None', hint: 'No banner at all' },
];

const ROUNDED: { value: FormTheme['rounded']; label: string }[] = [
  { value: 'sharp', label: 'Sharp' },
  { value: 'soft', label: 'Soft' },
  { value: 'pill', label: 'Pill' },
];

export default function FormAppearancePanel({
  formId,
  formName,
  description,
  fields,
  submitLabel,
  theme: savedTheme,
  onUpdate,
}: {
  formId: string;
  formName: string;
  description: string | null;
  fields: FormBuilderField[];
  submitLabel: string;
  theme: unknown;
  onUpdate: (patch: { settings: Record<string, unknown> }) => void;
}) {
  const [theme, setTheme] = useState<FormTheme>(() =>
    resolveFormTheme(savedTheme),
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const patch = <K extends keyof FormTheme>(key: K, value: FormTheme[K]) => {
    setTheme((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/forms/${formId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Only `theme` is sent. Settings are merged server-side, so every
        // other setting keeps its value rather than being reset to the
        // defaults this panel happens to know about.
        body: JSON.stringify({ settings: { theme } }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      onUpdate(updated);
      setDirty(false);
      toast.success('Appearance saved');
    } catch {
      toast.error('Could not save appearance');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-6">
      {/* Controls */}
      <div className="w-80 shrink-0 space-y-6 overflow-y-auto pr-1">
        <Group
          title="Colour scheme"
          hint="A hosted form is your page, not the visitor's app — so it defaults to light rather than following their device."
        >
          <div className="grid grid-cols-3 gap-2">
            {SCHEMES.map((s) => (
              <button
                key={s.value}
                type="button"
                title={s.hint}
                onClick={() => patch('color_scheme', s.value)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-[11px] font-medium transition-colors',
                  theme.color_scheme === s.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:bg-muted',
                )}
              >
                <s.icon className="h-4 w-4" />
                {s.label}
              </button>
            ))}
          </div>
        </Group>

        <Group title="Accent colour">
          <div className="grid grid-cols-6 gap-2">
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                title={p.name}
                aria-label={p.name}
                onClick={() => patch('accent', p.value)}
                className={cn(
                  'flex h-8 w-full items-center justify-center rounded-md border-2 transition-transform hover:scale-105',
                  theme.accent === p.value
                    ? 'border-foreground'
                    : 'border-transparent',
                )}
                style={{ backgroundColor: p.value }}
              >
                {theme.accent === p.value && (
                  <Check className="h-3.5 w-3.5 text-white drop-shadow" />
                )}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <input
              type="color"
              aria-label="Custom accent colour"
              value={theme.accent}
              onChange={(e) => patch('accent', e.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent"
            />
            <Input
              value={theme.accent}
              spellCheck={false}
              className="h-8 font-mono text-xs"
              onChange={(e) => {
                const raw = e.target.value.trim();
                // Typed freely so a half-entered "#7c3" is not stamped
                // back to the default mid-keystroke; only a complete,
                // valid hex is committed.
                setDirty(true);
                setTheme((prev) => ({
                  ...prev,
                  accent: /^#[0-9a-fA-F]{6}$/.test(raw)
                    ? raw.toLowerCase()
                    : prev.accent,
                }));
              }}
            />
          </div>
        </Group>

        <Group title="Header">
          <div className="grid grid-cols-2 gap-2">
            {HEADERS.map((h) => (
              <button
                key={h.value}
                type="button"
                title={h.hint}
                onClick={() => patch('header_style', h.value)}
                className={cn(
                  'rounded-lg border px-2 py-2 text-[11px] font-medium transition-colors',
                  theme.header_style === h.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:bg-muted',
                )}
              >
                {h.label}
              </button>
            ))}
          </div>
        </Group>

        <Group title="Corners">
          <div className="grid grid-cols-3 gap-2">
            {ROUNDED.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => patch('rounded', r.value)}
                className={cn(
                  'border px-2 py-2 text-[11px] font-medium transition-colors',
                  r.value === 'sharp' && 'rounded-sm',
                  r.value === 'soft' && 'rounded-lg',
                  r.value === 'pill' && 'rounded-full',
                  theme.rounded === r.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:bg-muted',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </Group>

        <Group title="Branding">
          <div className="flex items-center justify-between gap-2">
            <div>
              <Label className="text-xs font-medium">
                Hide &ldquo;Powered by&rdquo;
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Removes the line under the form
              </p>
            </div>
            <Switch
              checked={theme.hide_branding}
              onCheckedChange={(v) => patch('hide_branding', v)}
            />
          </div>
        </Group>

        <div className="flex items-center gap-2 pb-2">
          <Button id="btn-save-appearance" disabled={!dirty || saving} onClick={save}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save appearance
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTheme(DEFAULT_FORM_THEME);
              setDirty(true);
            }}
          >
            Reset
          </Button>
        </div>
      </div>

      {/* Preview */}
      <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border bg-muted/20">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card/95 px-4 py-2 backdrop-blur">
          <span className="text-xs font-medium text-muted-foreground">
            Live preview
          </span>
          <span
            className="ml-auto rounded-full border px-2 py-0.5 font-mono text-[10px]"
            style={{
              borderColor: safeAccent(theme.accent),
              color: safeAccent(theme.accent),
            }}
          >
            {safeAccent(theme.accent)}
          </span>
        </div>

        <FormSurface
          theme={theme}
          name={formName}
          description={description}
          preview
          booking={fields.some((f) => f.type === 'appointment_slot')}
        >
          <FormRenderer
            form={{
              id: formId,
              name: formName,
              description,
              slug: 'preview',
              kind: 'form',
              fields,
              settings: { submit_label: submitLabel, honeypot: false },
            }}
            preview
          />
        </FormSurface>
      </div>
    </div>
  );
}

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {hint && (
        <p className="mt-1 mb-2 text-[11px] leading-relaxed text-muted-foreground/80">
          {hint}
        </p>
      )}
      <div className={hint ? '' : 'mt-2'}>{children}</div>
    </section>
  );
}
