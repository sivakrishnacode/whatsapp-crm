'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarX, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

interface Slot {
  start: string;
  end: string;
  remaining: number;
}

interface SlotDay {
  date: string;
  slots: Slot[];
}

/**
 * Pick a real, currently-free time.
 *
 * WHY THIS EXISTS RATHER THAN A DATE + TIME FIELD
 *   A free-choice date and time field lets the customer ask for 3pm when you
 *   are already booked at 3pm, which puts you straight back into manual
 *   back-and-forth. Offering only slots the server says are free is the whole
 *   difference between "request an appointment" and "book an appointment".
 *
 * THE LIST IS ALWAYS FETCHED, NEVER CACHED
 *   A cached slot list is a list of times that may already be gone. It is
 *   re-fetched on mount and on every page change, and the server re-checks
 *   again at submit — because even a fresh list is stale the moment somebody
 *   else clicks.
 *
 * SHARED BY THE HOSTED PAGE AND THE WIDGET
 *   So it takes its data-loading endpoint as a prop and holds no session or
 *   dashboard imports. The two contexts hit different endpoints (a slug for
 *   the hosted page, a token for reschedule) and neither should be baked in.
 */
export function SlotPicker({
  fetchSlots,
  value,
  onChange,
  accent = '#2D7FF9',
}: {
  /** Returns the offered days. Called on mount and on page change. */
  fetchSlots: (range: { from: string; to: string }) => Promise<{
    timezone: string;
    days: SlotDay[];
  }>;
  /** The chosen slot's ISO start, or null. */
  value: string | null;
  onChange: (startIso: string | null) => void;
  accent?: string;
}) {
  const [days, setDays] = useState<SlotDay[]>([]);
  const [timezone, setTimezone] = useState<string>('UTC');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** How many 14-day pages forward we are. */
  const [page, setPage] = useState(0);
  const [activeDate, setActiveDate] = useState<string | null>(null);

  const range = useMemo(() => {
    const from = new Date();
    from.setDate(from.getDate() + page * 14);
    const to = new Date(from);
    to.setDate(to.getDate() + 13);
    return { from: isoDate(from), to: isoDate(to) };
  }, [page]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSlots(range);
      setDays(result.days);
      setTimezone(result.timezone);
      // Select the first day that has anything, so the picker opens showing
      // times rather than an empty panel the visitor has to hunt through.
      setActiveDate((prev) => {
        if (prev && result.days.some((d) => d.date === prev)) return prev;
        return result.days[0]?.date ?? null;
      });
    } catch {
      setError('Could not load available times.');
    } finally {
      setLoading(false);
    }
  }, [fetchSlots, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = days.find((day) => day.date === activeDate);

  return (
    <div className="rounded-lg border border-input">
      <div className="flex items-center justify-between gap-2 border-b border-input px-3 py-2">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0 || loading}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
          aria-label="Earlier dates"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <p className="text-xs text-muted-foreground">
          {loading ? 'Loading times…' : `Times shown in ${timezone}`}
        </p>
        <button
          type="button"
          onClick={() => setPage((p) => p + 1)}
          disabled={loading}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
          aria-label="Later dates"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Finding available times…
        </div>
      ) : error ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{error}</p>
      ) : days.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <CalendarX className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No times available in this period.
          </p>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            className="text-xs underline underline-offset-2"
            style={{ color: accent }}
          >
            Look further ahead
          </button>
        </div>
      ) : (
        <>
          {/* Dates as a horizontal strip rather than a month grid: a booking
              form usually has a handful of open days, and a calendar with 26
              greyed-out cells communicates less than five real ones. */}
          <div className="flex gap-2 overflow-x-auto border-b border-input px-3 py-2">
            {days.map((day) => {
              const selected = day.date === activeDate;
              return (
                <button
                  key={day.date}
                  type="button"
                  onClick={() => setActiveDate(day.date)}
                  className={cn(
                    'shrink-0 rounded-lg border px-3 py-2 text-center transition-colors',
                    selected
                      ? 'border-transparent text-white'
                      : 'border-input hover:bg-muted',
                  )}
                  style={selected ? { backgroundColor: accent } : undefined}
                >
                  <span className="block text-[10px] uppercase opacity-80">
                    {weekdayLabel(day.date)}
                  </span>
                  <span className="block text-sm font-semibold">
                    {dayLabel(day.date)}
                  </span>
                  <span className="block text-[10px] opacity-80">
                    {day.slots.length} free
                  </span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-3 gap-2 p-3 sm:grid-cols-4">
            {active?.slots.map((slot) => {
              const selected = slot.start === value;
              return (
                <button
                  key={slot.start}
                  type="button"
                  onClick={() => onChange(selected ? null : slot.start)}
                  className={cn(
                    'rounded-lg border px-2 py-2 text-xs font-medium transition-colors',
                    selected
                      ? 'border-transparent text-white'
                      : 'border-input hover:bg-muted',
                  )}
                  style={selected ? { backgroundColor: accent } : undefined}
                  // Group bookings show remaining seats; a 1-of-1 slot would
                  // just be noise.
                  title={
                    slot.remaining > 1
                      ? `${slot.remaining} places left`
                      : undefined
                  }
                >
                  {timeLabel(slot.start, timezone)}
                  {slot.remaining > 1 && (
                    <span className="mt-0.5 block text-[10px] font-normal opacity-70">
                      {slot.remaining} left
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Date labels are built from the `YYYY-MM-DD` string with a midday anchor.
 *
 * `new Date('2026-08-03')` parses as UTC midnight, which in any negative-offset
 * zone renders as the 2nd — so a visitor in New York would see every date one
 * day early. Anchoring at noon puts it far enough from both boundaries that no
 * offset can shift the calendar day.
 */
function dateFromIsoDay(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

function weekdayLabel(iso: string): string {
  return dateFromIsoDay(iso).toLocaleDateString(undefined, { weekday: 'short' });
}

function dayLabel(iso: string): string {
  return dateFromIsoDay(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Slot times are rendered in the BUSINESS's timezone, not the visitor's.
 *
 * Deliberate: the label above the grid says which zone, and showing "10:00
 * (Europe/London)" is unambiguous. Converting to the visitor's device zone
 * silently would mean a customer and the business quoting different times to
 * each other for the same booking.
 */
function timeLabel(startIso: string, timezone: string): string {
  return new Date(startIso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  });
}
