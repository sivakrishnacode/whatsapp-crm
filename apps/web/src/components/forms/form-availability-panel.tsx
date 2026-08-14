'use client';

import { useState } from 'react';
import { CalendarClock, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface AvailabilityWindow {
  weekday: number;
  start: string;
  end: string;
}

export interface Availability {
  timezone: string;
  slot_minutes: number;
  buffer_minutes: number;
  min_notice_minutes: number;
  window_days: number;
  capacity: number;
  windows: AvailabilityWindow[];
  blackout_dates?: string[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * When a booking form's slot picker offers times.
 *
 * WHY AVAILABILITY IS A FORM SETTING RATHER THAN ITS OWN SECTION
 *   An earlier design had `appointment_types`, `availability_rules` and
 *   `availability_exceptions` behind a top-level Appointments nav item. That
 *   meant a user configuring "when can people book" had to visit a different
 *   part of the app from the one where they wrote the questions — and it
 *   duplicated the form builder to collect the same thing twice.
 *
 *   A booking IS a form with a time picker in it, so its hours belong next to
 *   its fields.
 *
 * ONLY SHOWN FOR FORMS THAT HAVE A SLOT FIELD
 *   The presence of an `appointment_slot` field is what makes a form a booking
 *   form — there is no separate flag to keep in sync. So this panel tells the
 *   user to add one rather than letting them configure hours for a form that
 *   can never use them.
 */
export default function FormAvailabilityPanel({
  formId,
  hasSlotField,
  availability,
  onUpdate,
}: {
  formId: string;
  hasSlotField: boolean;
  availability: Availability | null;
  onUpdate: (next: Availability | null) => void;
}) {
  const [draft, setDraft] = useState<Availability>(
    availability ?? defaultAvailability(),
  );
  const [enabled, setEnabled] = useState(availability !== null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const next = enabled
        ? { ...draft, windows: draft.windows.filter((w) => w.start < w.end) }
        : null;

      const res = await fetch(`/api/forms/${formId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ availability: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? 'Save failed');
      }
      onUpdate(next);
      toast.success('Availability saved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!hasSlotField) {
    return (
      <div className="mx-auto max-w-lg py-12 text-center">
        <CalendarClock className="mx-auto size-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium text-foreground">
          This form doesn’t take bookings yet
        </p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          Add a <strong>Time slot</strong> field on the Builder tab. That field
          is what turns a form into a booking form — visitors then pick from
          times you’re genuinely free, and two people can’t take the same one.
        </p>
      </div>
    );
  }

  const set = <K extends keyof Availability>(key: K, value: Availability[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="max-w-2xl space-y-6 p-4">
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            Accept bookings
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Off means the time picker shows nothing, so nobody can book.
          </p>
        </div>
        <Button
          variant={enabled ? 'outline' : 'default'}
          size="sm"
          onClick={() => setEnabled((v) => !v)}
        >
          {enabled ? 'Turn off' : 'Turn on'}
        </Button>
      </div>

      {enabled && (
        <>
          <section className="space-y-4 rounded-xl border border-border bg-card p-4">
            <p className="text-sm font-semibold text-foreground">Slot shape</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tz">Timezone</Label>
                <Input
                  id="tz"
                  value={draft.timezone}
                  onChange={(e) => set('timezone', e.target.value)}
                  placeholder="Asia/Kolkata"
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Your hours are read in this zone. Visitors see times in it
                  too, labelled — so nobody quotes a different time to you.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="slot">Appointment length (minutes)</Label>
                <Input
                  id="slot"
                  type="number"
                  min={5}
                  max={480}
                  value={draft.slot_minutes}
                  onChange={(e) =>
                    set('slot_minutes', Number(e.target.value) || 30)
                  }
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="buffer">Gap between appointments</Label>
                <Input
                  id="buffer"
                  type="number"
                  min={0}
                  max={240}
                  value={draft.buffer_minutes}
                  onChange={(e) =>
                    set('buffer_minutes', Number(e.target.value) || 0)
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Reserved either side of a booking, so back-to-back slots
                  aren’t offered.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="notice">Minimum notice (minutes)</Label>
                <Input
                  id="notice"
                  type="number"
                  min={0}
                  value={draft.min_notice_minutes}
                  onChange={(e) =>
                    set('min_notice_minutes', Number(e.target.value) || 0)
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Stops someone booking a slot ten minutes from now.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="window">How far ahead people can book (days)</Label>
                <Input
                  id="window"
                  type="number"
                  min={1}
                  max={365}
                  value={draft.window_days}
                  onChange={(e) =>
                    set('window_days', Number(e.target.value) || 30)
                  }
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="capacity">Places per slot</Label>
                <Input
                  id="capacity"
                  type="number"
                  min={1}
                  value={draft.capacity}
                  onChange={(e) => set('capacity', Number(e.target.value) || 1)}
                />
                <p className="text-xs text-muted-foreground">
                  Leave at 1 for one-to-one. Above 1 makes it a group session —
                  and note that the database guarantee against two people
                  taking the same slot only applies at 1.
                </p>
              </div>
            </div>
          </section>

          <section className="space-y-3 rounded-xl border border-border bg-card p-4">
            <p className="text-sm font-semibold text-foreground">
              When you’re available
            </p>

            {draft.windows.length === 0 && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-accent-amber">
                No hours set, so no times will be offered.
              </p>
            )}

            {draft.windows.map((window, index) => (
              <div key={index} className="flex items-center gap-2">
                <Select
                  value={String(window.weekday)}
                  onValueChange={(v) =>
                    setDraft((prev) => ({
                      ...prev,
                      windows: prev.windows.map((w, i) =>
                        i === index && v !== null
                          ? { ...w, weekday: Number(v) }
                          : w,
                      ),
                    }))
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
                    setDraft((prev) => ({
                      ...prev,
                      windows: prev.windows.map((w, i) =>
                        i === index ? { ...w, start: e.target.value } : w,
                      ),
                    }))
                  }
                  className="w-28"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="time"
                  value={window.end}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      windows: prev.windows.map((w, i) =>
                        i === index ? { ...w, end: e.target.value } : w,
                      ),
                    }))
                  }
                  className="w-28"
                />

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      windows: prev.windows.filter((_, i) => i !== index),
                    }))
                  }
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Remove these hours"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  windows: [
                    ...prev.windows,
                    { weekday: 1, start: '09:00', end: '17:00' },
                  ],
                }))
              }
            >
              <Plus className="size-4" />
              Add hours
            </Button>
            <p className="text-xs text-muted-foreground">
              Two rows on the same day models a lunch break.
            </p>
          </section>

          <section className="space-y-2 rounded-xl border border-border bg-card p-4">
            <Label htmlFor="blackout">Closed dates</Label>
            <Input
              id="blackout"
              value={(draft.blackout_dates ?? []).join(', ')}
              onChange={(e) =>
                set(
                  'blackout_dates',
                  e.target.value
                    .split(',')
                    .map((d) => d.trim())
                    .filter(Boolean),
                )
              }
              placeholder="2026-12-25, 2026-12-26"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated <code>YYYY-MM-DD</code>. Holidays and one-off
              closures — no times are offered on these days.
            </p>
          </section>
        </>
      )}

      <Button onClick={save} disabled={saving}>
        {saving ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Save className="size-4" />
        )}
        Save availability
      </Button>
    </div>
  );
}

/** Mon–Fri 9–5, 30-minute slots: the shape most people want to start from. */
function defaultAvailability(): Availability {
  return {
    timezone:
      typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : 'UTC',
    slot_minutes: 30,
    buffer_minutes: 0,
    min_notice_minutes: 60,
    window_days: 30,
    capacity: 1,
    windows: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      start: '09:00',
      end: '17:00',
    })),
    blackout_dates: [],
  };
}
