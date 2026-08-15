'use client';

/**
 * Booked appointments for one form.
 *
 * WHY THIS EXISTS
 *   `GET /bookings` and `PATCH /bookings/:id/status` were built and
 *   tenant-scoped, and nothing in the web app called either. So a booking
 *   was only visible as a row in Submissions with a timestamp buried in
 *   it — no upcoming list, no Meet link, and no way to mark a no-show,
 *   even though the endpoint for it existed. The comment on `setStatus`
 *   says "from the calendar", which is the screen this is.
 *
 * ⚠️ THE LIST RESPONSE CARRIES `manage_url`, WHICH IS A BEARER CREDENTIAL.
 *   It authorises rescheduling and cancelling with no login. It is
 *   deliberately NOT rendered here and never copied into the DOM: the
 *   business already has the status control below, so there is nothing it
 *   would let them do that they cannot do already — and a manage link on
 *   screen is one shoulder-surf from a stranger cancelling a customer's
 *   appointment.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  CalendarClock,
  CalendarX,
  Check,
  Loader2,
  RefreshCw,
  User,
  Video,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { EditorEmptyState, EditorScreen } from './form-editor-shell';

type BookingStatus = 'confirmed' | 'cancelled' | 'completed' | 'no_show';

interface Booking {
  id: string;
  form_name: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: BookingStatus;
  contact: { id: string; name: string | null; phone: string | null } | null;
  notes: string | null;
  meeting_url?: string | null;
}

const STATUS_LABEL: Record<BookingStatus, string> = {
  confirmed: 'Confirmed',
  completed: 'Completed',
  no_show: 'No show',
  cancelled: 'Cancelled',
};

/**
 * Ink + surface token pairs, which `globals.css` defines for both themes.
 * The `border-blue-300` family these replaced is a light-only palette class,
 * and this app's default theme is dark — the badges were nearly invisible.
 */
const STATUS_CLASS: Record<BookingStatus, string> = {
  confirmed: 'border-accent-blue/40 bg-accent-blue-surface text-accent-blue',
  completed: 'border-accent-green/40 bg-accent-green-surface text-accent-green',
  no_show: 'border-accent-amber/40 bg-accent-amber-surface text-accent-amber',
  cancelled: 'border-accent-red/40 bg-accent-red-surface text-accent-red',
};

export default function FormAppointmentsPanel({
  formId,
  onCountChange,
}: {
  formId: string;
  /** Lets the tab badge agree with what the list actually holds. */
  onCountChange?: (count: number) => void;
}) {
  const router = useRouter();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * A refetch that keeps the list on screen.
   *
   * Worth a button: this panel fetches once on mount and is unmounted
   * between tab visits, so without one the only way to see a booking that
   * landed a minute ago is to leave the tab and come back.
   */
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Read once at mount: comparing against the clock during render is
  // impure and would disagree between passes.
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/bookings?form_id=${formId}`, {
        cache: 'no-store',
      });
      const data = res.ok ? await res.json() : [];
      const rows = Array.isArray(data) ? (data as Booking[]) : [];
      setBookings(rows);
      onCountChange?.(rows.length);
    } catch {
      toast.error('Could not load appointments');
    } finally {
      setLoading(false);
    }
    // onCountChange is an inline callback from the editor; depending on it
    // would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const setStatus = async (id: string, status: BookingStatus) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/bookings/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error();
      const updated = (await res.json()) as Booking;
      setBookings((prev) =>
        prev.map((b) => (b.id === id ? { ...b, ...updated } : b))
      );
      toast.success(`Marked ${STATUS_LABEL[status].toLowerCase()}`);
    } catch {
      toast.error('Could not update the appointment');
    } finally {
      setBusyId(null);
    }
  };

  const refreshAction = (
    <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
      <RefreshCw className={cn('mr-2 size-4', refreshing && 'animate-spin')} />
      Refresh
    </Button>
  );

  if (loading) {
    return (
      <Screen>
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        </div>
      </Screen>
    );
  }

  if (bookings.length === 0) {
    return (
      <Screen actions={refreshAction}>
        <EditorEmptyState icon={CalendarX} title="No appointments yet">
          Times booked through this form appear here, with the meeting link and
          a way to mark what happened.
        </EditorEmptyState>
      </Screen>
    );
  }

  // Split rather than sorted into one list: "what is coming up" and "what
  // happened" are different questions, and a single list ordered by time
  // buries today's appointments under last month's.
  const upcoming = bookings.filter(
    (b) => new Date(b.starts_at).getTime() >= now && b.status !== 'cancelled'
  );
  const rest = bookings.filter((b) => !upcoming.includes(b));

  return (
    <Screen
      actions={refreshAction}
      summary={`${upcoming.length} upcoming · ${bookings.length} in total`}
    >
      <div className="flex flex-col gap-6">
        <Section
          title="Upcoming"
          count={upcoming.length}
          empty="Nothing booked ahead."
        >
          {upcoming.map((b) => (
            <BookingRow
              key={b.id}
              booking={b}
              busy={busyId === b.id}
              onStatus={setStatus}
              onOpenContact={(id) => router.push(`/contacts?contact=${id}`)}
            />
          ))}
        </Section>

        {rest.length > 0 && (
          <Section title="Past and cancelled" count={rest.length}>
            {rest.map((b) => (
              <BookingRow
                key={b.id}
                booking={b}
                busy={busyId === b.id}
                onStatus={setStatus}
                onOpenContact={(id) => router.push(`/contacts?contact=${id}`)}
              />
            ))}
          </Section>
        )}
      </div>
    </Screen>
  );
}

/** One heading for every state this panel can be in — loading, empty and
 *  full — so the screen does not change shape as the data arrives. */
function Screen({
  children,
  actions,
  summary,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  summary?: string;
}) {
  return (
    <EditorScreen
      title="Appointments"
      description={
        summary ?? 'Everything booked through this form, upcoming times first.'
      }
      actions={actions}
    >
      {children}
    </EditorScreen>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
        {title} {count > 0 && <span className="ml-1">({count})</span>}
      </h3>
      {count === 0 ? (
        // Centred, not left-aligned: this strip is now the full width of
        // the screen, and one short sentence pinned to its left edge reads
        // as a stray label rather than the state of the list.
        <p className="border-border text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-xs">
          {empty}
        </p>
      ) : (
        <div className="flex flex-col gap-2">{children}</div>
      )}
    </section>
  );
}

function BookingRow({
  booking,
  busy,
  onStatus,
  onOpenContact,
}: {
  booking: Booking;
  busy: boolean;
  onStatus: (id: string, status: BookingStatus) => void;
  onOpenContact: (contactId: string) => void;
}) {
  const cancelled = booking.status === 'cancelled';

  return (
    /*
     * Three tracks, not `flex-wrap`. Wrapping put every row's badge and
     * Mark button at a different x depending on how long the contact's name
     * was, so nothing lined up down the column — which is the one thing a
     * list of rows is for. Icon | when-and-who | actions, with the actions
     * on a single right-hand edge.
     */
    <div
      className={cn(
        'border-border bg-card grid grid-cols-1 items-start gap-3 rounded-xl border p-3.5',
        'sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center',
        cancelled && 'opacity-60'
      )}
    >
      <CalendarClock className="text-muted-foreground h-4 w-4 shrink-0" />

      <div className="min-w-0">
        <p
          className={cn(
            'text-sm font-medium',
            cancelled && 'text-muted-foreground line-through'
          )}
        >
          {formatWhen(booking.starts_at, booking.timezone)}
        </p>
        <p className="text-muted-foreground text-xs">
          {booking.contact?.name ?? 'Unknown contact'}
          {booking.contact?.phone ? ` · ${booking.contact.phone}` : ''}
          {' · '}
          {booking.timezone}
        </p>
      </div>

      {/* One track for everything actionable, right-aligned. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {booking.meeting_url && !cancelled && (
          <a
            href={booking.meeting_url}
            target="_blank"
            rel="noreferrer"
            className="border-border hover:bg-muted flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium"
          >
            <Video className="h-3.5 w-3.5" />
            Join
          </a>
        )}

        {booking.contact && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => onOpenContact(booking.contact!.id)}
          >
            <User className="h-3 w-3" />
            Contact
          </Button>
        )}

        <Badge
          variant="outline"
          className={cn('text-xs', STATUS_CLASS[booking.status])}
        >
          {STATUS_LABEL[booking.status]}
        </Badge>

        <DropdownMenu>
          {/* base-ui, not Radix: the trigger renders its own element and
            takes no `asChild`, so the styling goes on it directly. */}
          <DropdownMenuTrigger
            disabled={busy}
            aria-label="Change appointment status"
            className="hover:bg-muted inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            Mark
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(
              [
                'completed',
                'no_show',
                'confirmed',
                'cancelled',
              ] as BookingStatus[]
            )
              .filter((s) => s !== booking.status)
              .map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => onStatus(booking.id, s)}
                >
                  {STATUS_LABEL[s]}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function formatWhen(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  });
}
