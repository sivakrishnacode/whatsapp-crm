'use client';

import { useCallback, useEffect, useState } from 'react';
import { Clock, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface BusinessHoursWindow {
  weekday: number;
  start: string;
  end: string;
}

interface BusinessHours {
  timezone: string;
  windows: BusinessHoursWindow[];
}

interface WebStatus {
  prechat_form_id: string | null;
  offline_form_id: string | null;
  business_hours: BusinessHours | null;
}

interface FormOption {
  id: string;
  name: string;
  status: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Sentinel for "no form", since a Select cannot hold null. */
const NONE = '__none__';

/**
 * Behaviour settings: which form greets a visitor, which one catches them
 * out of hours, and when "out of hours" is.
 *
 * WHY THESE THREE LIVE TOGETHER
 *   They are one decision. "Capture details before chatting", "what happens
 *   when nobody is around" and "when is nobody around" are meaningless
 *   apart — an offline form with no business hours never shows, and business
 *   hours with no offline form only changes a sentence of copy. Splitting
 *   them across screens is how an account ends up with one configured and
 *   not the other.
 */
export function WebBehaviour() {
  const [status, setStatus] = useState<WebStatus | null>(null);
  const [forms, setForms] = useState<FormOption[]>([]);
  const [prechat, setPrechat] = useState<string>(NONE);
  const [offline, setOffline] = useState<string>(NONE);
  const [hoursEnabled, setHoursEnabled] = useState(false);
  const [timezone, setTimezone] = useState('UTC');
  const [windows, setWindows] = useState<BusinessHoursWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [configRes, formsRes] = await Promise.all([
        fetch('/api/web/config', { cache: 'no-store' }),
        fetch('/api/forms', { cache: 'no-store' }),
      ]);
      if (!configRes.ok) throw new Error('config');

      const config = (await configRes.json()) as WebStatus;
      setStatus(config);
      setPrechat(config.prechat_form_id ?? NONE);
      setOffline(config.offline_form_id ?? NONE);
      setHoursEnabled(config.business_hours !== null);
      setTimezone(
        config.business_hours?.timezone ??
          // The browser's zone is right far more often than UTC for an SMB
          // configuring their own opening hours.
          Intl.DateTimeFormat().resolvedOptions().timeZone ??
          'UTC',
      );
      setWindows(config.business_hours?.windows ?? defaultWeek());

      if (formsRes.ok) {
        const list = (await formsRes.json()) as FormOption[];
        // Only published forms can be shown to a visitor, so offering a
        // draft here would configure something that silently never appears.
        setForms(list.filter((f) => f.status === 'published'));
      }
    } catch {
      toast.error('Could not load the widget behaviour settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/web/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prechat_form_id: prechat === NONE ? null : prechat,
          offline_form_id: offline === NONE ? null : offline,
          // `null` clears the schedule, which the API reads as "always
          // open" — distinct from an empty window list, which would mean
          // "never open" and is never what anyone intends.
          business_hours: hoursEnabled
            ? { timezone, windows: windows.filter((w) => w.start < w.end) }
            : null,
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
      toast.success('Behaviour saved.');
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
        Loading behaviour settings…
      </div>
    );
  }

  if (!status) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        Could not load behaviour settings. Reload the page to try again.
      </p>
    );
  }

  const dirty =
    (status.prechat_form_id ?? NONE) !== prechat ||
    (status.offline_form_id ?? NONE) !== offline ||
    (status.business_hours !== null) !== hoursEnabled ||
    (hoursEnabled &&
      JSON.stringify(status.business_hours) !==
        JSON.stringify({ timezone, windows }));

  return (
    <div className="max-w-3xl space-y-6">
      <section className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm font-semibold text-foreground">
          Before the chat starts
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Ask for details before a visitor can send their first message. Leave
          this off and the widget uses its built-in name and phone screen.
        </p>

        <div className="mt-4 space-y-1.5">
          <Label>Pre-chat form</Label>
          <FormSelect
            value={prechat}
            onChange={setPrechat}
            forms={forms}
            noneLabel="Built-in name & phone screen"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">
              Business hours
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Outside these hours the widget says you’re away. Off means always
              available.
            </p>
          </div>
          <Switch checked={hoursEnabled} onCheckedChange={setHoursEnabled} />
        </div>

        {hoursEnabled && (
          <div className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tz">Timezone</Label>
              <Input
                id="tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Asia/Kolkata"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Hours are read in this zone, so daylight saving is handled for
                you.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Open hours</Label>
              {windows.length === 0 && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  No open hours set, so the widget will always show as away.
                </p>
              )}

              {windows.map((window, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Select
                    value={String(window.weekday)}
                    onValueChange={(v) =>
                      setWindows((prev) =>
                        prev.map((w, i) =>
                          i === index && v !== null
                            ? { ...w, weekday: Number(v) }
                            : w,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAYS.map((day, dayIndex) => (
                        <SelectItem key={day} value={String(dayIndex)}>
                          {day}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Input
                    type="time"
                    value={window.start}
                    onChange={(e) =>
                      setWindows((prev) =>
                        prev.map((w, i) =>
                          i === index ? { ...w, start: e.target.value } : w,
                        ),
                      )
                    }
                    className="w-28"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={window.end}
                    onChange={(e) =>
                      setWindows((prev) =>
                        prev.map((w, i) =>
                          i === index ? { ...w, end: e.target.value } : w,
                        ),
                      )
                    }
                    className="w-28"
                  />

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setWindows((prev) => prev.filter((_, i) => i !== index))
                    }
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove this window"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}

              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setWindows((prev) => [
                    ...prev,
                    { weekday: 1, start: '09:00', end: '17:00' },
                  ])
                }
              >
                <Plus className="size-4" />
                Add hours
              </Button>
              <p className="text-xs text-muted-foreground">
                Add two rows for the same day to model a lunch break.
              </p>
            </div>

            <div className="space-y-1.5 border-t border-border pt-4">
              <Label>Form to show when you’re away</Label>
              <FormSelect
                value={offline}
                onChange={setOffline}
                forms={forms}
                noneLabel="Let them send a message anyway"
              />
              <p className="text-xs text-muted-foreground">
                With no form, visitors can still write to you — the message
                waits in the inbox. A form is better when you need an email
                address to reply to.
              </p>
            </div>
          </div>
        )}
      </section>

      {forms.length === 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          <Clock className="mt-0.5 size-3.5 shrink-0" />
          You have no published forms yet. Build one under Forms and publish it
          to use it here.
        </p>
      )}

      <Button onClick={save} disabled={saving || !dirty}>
        {saving ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Save className="size-4" />
        )}
        Save changes
      </Button>
    </div>
  );
}

function FormSelect({
  value,
  onChange,
  forms,
  noneLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  forms: FormOption[];
  noneLabel: string;
}) {
  return (
    // base-ui's Select can emit null (cleared). Coerced to the explicit
    // "none" sentinel so `null` never reaches the PATCH as an accidental
    // "leave unchanged" when the user meant "no form".
    <Select value={value} onValueChange={(v) => onChange(v ?? NONE)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{noneLabel}</SelectItem>
        {forms.map((form) => (
          <SelectItem key={form.id} value={form.id}>
            {form.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Mon–Fri 9–5, the schedule almost every account wants as a starting point. */
function defaultWeek(): BusinessHoursWindow[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    start: '09:00',
    end: '17:00',
  }));
}
