'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, Loader2, Plus, Save, Trash2 } from 'lucide-react';
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
import {
  EditorActionBar,
  EditorCard,
  EditorEmptyState,
  EditorGrid,
  EditorScreen,
} from './form-editor-shell';

interface AvailabilityWindow {
  weekday: number;
  start: string;
  end: string;
}

export interface AvailabilityCalendar {
  connection_id: string;
  calendar_id: string;
  block_busy: boolean;
  create_event: boolean;
  add_meet: boolean;
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
  calendar?: AvailabilityCalendar;
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
    availability ?? defaultAvailability()
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
      <EditorScreen
        title="Availability"
        description="When this form offers times, and what it does with a booking."
      >
        <EditorEmptyState
          icon={CalendarClock}
          title="This form doesn’t take bookings yet"
        >
          Add a <strong>Time slot</strong> field on the Build tab. That field is
          what turns a form into a booking form — visitors then pick from times
          you’re genuinely free, and two people can’t take the same one.
        </EditorEmptyState>
      </EditorScreen>
    );
  }

  const set = <K extends keyof Availability>(key: K, value: Availability[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  return (
    <EditorScreen
      title="Availability"
      description="When the time picker offers slots, how long they are, and what happens on your calendar."
    >
      <div className="border-border bg-card flex items-start justify-between gap-4 rounded-xl border p-4">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-semibold">
            Accept bookings
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
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

      {/*
        Two columns from `lg` up: the numbers on the left, the calendar
        itself on the right. As one column this screen was five cards deep,
        so the Google Calendar section — the part people come here for
        second — lived below the fold with the whole right of the screen
        empty beside it.
      */}
      {enabled && (
        /*
         * 7/5, not 6/6. The hours rows are three fixed-width controls plus a
         * delete button — about 380px — and gain nothing from more room,
         * while Slot shape and Google Calendar are hint-heavy and are what
         * actually wanted the width. Each column packs independently, so
         * eleven rows of hours leaves no hole under Slot shape.
         */
        <EditorGrid className="mt-4 xl:grid-cols-12">
          <div className="flex flex-col gap-4 xl:col-span-7">
            <EditorCard
              title="Slot shape"
              description="How long an appointment is and how far ahead it can be booked."
            >
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
                  <p className="text-muted-foreground text-xs">
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
                  <p className="text-muted-foreground text-xs">
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
                  <p className="text-muted-foreground text-xs">
                    Stops someone booking a slot ten minutes from now.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="window">
                    How far ahead people can book (days)
                  </Label>
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
                    onChange={(e) =>
                      set('capacity', Number(e.target.value) || 1)
                    }
                  />
                  <p className="text-muted-foreground text-xs">
                    Leave at 1 for one-to-one. Above 1 makes it a group session
                    — and note that the database guarantee against two people
                    taking the same slot only applies at 1.
                  </p>
                </div>
              </div>
            </EditorCard>

            <CalendarSyncSection
              value={draft.calendar}
              onChange={(calendar) =>
                setDraft((d) => ({ ...d, calendar: calendar ?? undefined }))
              }
            />
          </div>

          <div className="flex flex-col gap-4 xl:col-span-5">
            <EditorCard
              title="When you’re available"
              description="Your weekly hours, in the timezone above. Two rows on the same day models a lunch break."
              contentClassName="gap-3"
            >
              {draft.windows.length === 0 && (
                <p className="border-accent-amber/30 bg-accent-amber-surface text-accent-amber rounded-lg border px-3 py-2 text-xs">
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
                            : w
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
                          i === index ? { ...w, start: e.target.value } : w
                        ),
                      }))
                    }
                    className="w-28"
                  />
                  <span className="text-muted-foreground text-xs">to</span>
                  <Input
                    type="time"
                    value={window.end}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        windows: prev.windows.map((w, i) =>
                          i === index ? { ...w, end: e.target.value } : w
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
                className="self-start"
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
                <Plus className="mr-1.5 size-4" />
                Add hours
              </Button>
            </EditorCard>

            <EditorCard
              title="Closed dates"
              description="Holidays and one-off closures — no times are offered on these days."
            >
              <Label htmlFor="blackout" className="sr-only">
                Closed dates
              </Label>
              <Input
                id="blackout"
                value={(draft.blackout_dates ?? []).join(', ')}
                onChange={(e) =>
                  set(
                    'blackout_dates',
                    e.target.value
                      .split(',')
                      .map((d) => d.trim())
                      .filter(Boolean)
                  )
                }
                placeholder="2026-12-25, 2026-12-26"
                className="font-mono text-xs"
              />
              <p className="text-muted-foreground text-xs">
                Comma-separated <code>YYYY-MM-DD</code>.
              </p>
            </EditorCard>
          </div>
        </EditorGrid>
      )}

      <EditorActionBar>
        <Button onClick={save} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Save className="mr-2 size-4" />
          )}
          Save availability
        </Button>
      </EditorActionBar>
    </EditorScreen>
  );
}

/**
 * Google Calendar sync.
 *
 * Reads the workspace's existing Google connections rather than starting
 * its own OAuth flow — one connection per workspace covers Sheets, Gmail,
 * Calendar and Meet, and minting a second would ask the customer to
 * approve scopes they have already granted.
 */
function CalendarSyncSection({
  value,
  onChange,
}: {
  value: AvailabilityCalendar | undefined;
  onChange: (next: AvailabilityCalendar | null) => void;
}) {
  const [connections, setConnections] = useState<
    {
      id: string;
      provider: string;
      displayName: string | null;
      status: string;
    }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/connections', { cache: 'no-store' });
        const data = res.ok ? await res.json() : [];
        if (!cancelled) {
          setConnections(
            Array.isArray(data) ? data : (data?.connections ?? [])
          );
        }
      } catch {
        // Leaves the list empty, which renders the "connect one" state —
        // the same thing a workspace with no connections sees.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const googleConnections = connections.filter((c) =>
    c.provider?.toLowerCase().includes('google')
  );

  const enabled = Boolean(value?.connection_id);

  if (loading) return null;

  return (
    /* Styled to match `EditorCard`, but hand-rolled because its header
       carries an action — the on/off switch for the whole section. */
    <section className="border-border bg-card space-y-3 rounded-xl border p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Google Calendar</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Hide times you are already busy, and put each booking on your
            calendar with a Meet link.
          </p>
        </div>
        {googleConnections.length > 0 && (
          <Button
            variant={enabled ? 'outline' : 'default'}
            size="sm"
            onClick={() =>
              onChange(
                enabled
                  ? null
                  : {
                      connection_id: googleConnections[0].id,
                      calendar_id: 'primary',
                      block_busy: true,
                      create_event: true,
                      add_meet: true,
                    }
              )
            }
          >
            {enabled ? 'Turn off' : 'Turn on'}
          </Button>
        )}
      </div>

      {googleConnections.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
          No Google account is connected to this workspace yet. Connect one
          under <strong>Integrations → Connected apps</strong>, then come back —
          the same connection covers Calendar and Meet.
        </p>
      ) : (
        enabled &&
        value && (
          <div className="space-y-3 border-t pt-3">
            <div className="space-y-1">
              <Label className="text-xs">Calendar account</Label>
              {/* The `Select` primitive, not a bare `<select>`: a native one
                  renders the OS control, which is the only thing on this
                  screen that ignores the app's theme. */}
              <Select
                value={value.connection_id}
                onValueChange={(v) =>
                  v && onChange({ ...value, connection_id: v })
                }
              >
                <SelectTrigger className="h-9 w-full text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {googleConnections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.displayName ?? c.provider}
                      {c.status !== 'active' ? ' (needs reconnecting)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Calendar</Label>
              <Input
                value={value.calendar_id}
                placeholder="primary"
                className="h-9 text-sm"
                onChange={(e) =>
                  onChange({
                    ...value,
                    calendar_id: e.target.value.trim() || 'primary',
                  })
                }
              />
              <p className="text-muted-foreground text-xs">
                <code>primary</code> is your own calendar. For a shared one,
                paste its id from Google Calendar settings.
              </p>
            </div>

            <SyncToggle
              label="Hide times I'm busy"
              hint="Events on this calendar are subtracted from the times offered."
              checked={value.block_busy}
              onChange={(v) => onChange({ ...value, block_busy: v })}
            />
            <SyncToggle
              label="Add each booking to my calendar"
              hint="Invites the customer, so Google sends the reminders."
              checked={value.create_event}
              onChange={(v) =>
                // Turning the event off has to turn Meet off with it: a
                // link can only exist on an event, and leaving the toggle
                // on would promise a link nobody ever receives.
                onChange({
                  ...value,
                  create_event: v,
                  add_meet: v ? value.add_meet : false,
                })
              }
            />
            <SyncToggle
              label="Create a Google Meet link"
              hint="Shown on the confirmation and in the calendar invite."
              checked={value.add_meet}
              onChange={(v) =>
                onChange({
                  ...value,
                  add_meet: v,
                  create_event: v ? true : value.create_event,
                })
              }
            />

            <p className="bg-muted/50 text-muted-foreground rounded-lg p-2.5 text-[11px] leading-relaxed">
              If Google is unreachable, bookings still go through — they just
              will not appear on your calendar. Times you are busy stay bookable
              in that case rather than the page offering nothing.
            </p>
          </div>
        )
      )}
    </section>
  );
}

function SyncToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <Label className="text-xs font-medium">{label}</Label>
        <p className="text-muted-foreground text-[11px]">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
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
