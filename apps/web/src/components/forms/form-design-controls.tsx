'use client';

/**
 * How the hosted form looks — the Design side of the builder's inspector.
 *
 * CONTROLLED, WITH NO SAVE OF ITS OWN
 *   This used to be a whole tab with its own preview and its own Save
 *   button, next to a Builder tab that already rendered a live canvas.
 *   Two previews of the same form and two Saves is one product pretending
 *   to be two. The canvas is the preview, and the editor's single Save
 *   writes fields and theme together.
 */

import { Check, Monitor, Moon, Sun } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  ACCENT_PRESETS,
  DEFAULT_FORM_THEME,
  type FormColorScheme,
  type FormHeaderStyle,
  type FormTheme,
} from '@/lib/forms/theme';

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

export default function FormDesignControls({
  theme,
  onChange,
}: {
  theme: FormTheme;
  onChange: (next: FormTheme) => void;
}) {
  const patch = <K extends keyof FormTheme>(key: K, value: FormTheme[K]) =>
    onChange({ ...theme, [key]: value });

  const setTheme = (updater: (prev: FormTheme) => FormTheme) =>
    onChange(updater(theme));

  return (
    <div className="space-y-6">
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

      <button
        type="button"
        onClick={() => onChange(DEFAULT_FORM_THEME)}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
      >
        Reset to defaults
      </button>
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
