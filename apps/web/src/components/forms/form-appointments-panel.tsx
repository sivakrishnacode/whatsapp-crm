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

const STATUS_CLASS: Record<BookingStatus, string> = {
  confirmed: 'border-blue-300 text-accent-blue',
  completed: 'border-green-300 text-accent-green',
  no_show: 'border-amber-300 text-accent-amber',
  cancelled: 'border-red-300 text-accent-red',
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
        prev.map((b) => (b.id === id ? { ...b, ...updated } : b)),
      );
      toast.success(`Marked ${STATUS_LABEL[status].toLowerCase()}`);
    } catch {
      toast.error('Could not update the appointment');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (bookings.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <CalendarX className="h-10 w-10 text-muted-foreground" />
        <p className="font-medium">No appointments yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Times booked through this form appear here, with the meeting link
          and a way to mark what happened.
        </p>
      </div>
    );
  }

  // Split rather than sorted into one list: "what is coming up" and "what
  // happened" are different questions, and a single list ordered by time
  // buries today's appointments under last month's.
  const upcoming = bookings.filter(
    (b) => new Date(b.starts_at).getTime() >= now && b.status !== 'cancelled',
  );
  const rest = bookings.filter((b) => !upcoming.includes(b));

  return (
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
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title} {count > 0 && <span className="ml-1">({count})</span>}
      </h3>
      {count === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
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
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border p-3',
        cancelled && 'opacity-60',
      )}
    >
      <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />

      <div className="min-w-[13rem] flex-1">
        <p
          className={cn(
            'text-sm font-medium',
            cancelled && 'text-muted-foreground line-through',
          )}
        >
          {formatWhen(booking.starts_at, booking.timezone)}
        </p>
        <p className="text-xs text-muted-foreground">
          {booking.contact?.name ?? 'Unknown contact'}
          {booking.contact?.phone ? ` · ${booking.contact.phone}` : ''}
          {' · '}
          {booking.timezone}
        </p>
      </div>

      {booking.meeting_url && !cancelled && (
        <a
          href={booking.meeting_url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
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
          className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
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
            ['completed', 'no_show', 'confirmed', 'cancelled'] as BookingStatus[]
          )
            .filter((s) => s !== booking.status)
            .map((s) => (
              <DropdownMenuItem key={s} onClick={() => onStatus(booking.id, s)}>
                {STATUS_LABEL[s]}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
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
