'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CalendarCheck,
  CalendarX,
  Loader2,
  RotateCcw,
  Video,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { forgetBookingByManageUrl } from '@/lib/forms/booking-memory';
import { SlotPicker } from './slot-picker';

interface Booking {
  id: string;
  form_name: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: string;
  /** Present when the form creates Google Meet links. */
  meeting_url?: string | null;
}

/**
 * The customer's own reschedule/cancel surface.
 *
 * AUTHORISED BY THE TOKEN IN THE URL, AND NOTHING ELSE
 *   The person who booked has no account and never will — asking them to sign
 *   in to move an appointment is how a booking product loses to a phone call.
 *   So the token is the credential.
 *
 *   That shapes the UI: it never shows anything the token holder did not
 *   already know (their own time, the form's name) and never lists other
 *   bookings, because a leaked link must expose exactly one appointment and no
 *   route to any other.
 */
export function ManageBooking({ token }: { token: string }) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [mode, setMode] = useState<'view' | 'reschedule'>('view');
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/public/bookings/${encodeURIComponent(token)}`,
        { cache: 'no-store' },
      );
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error('failed');
      setBooking((await res.json()) as Booking);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const fetchSlots = useCallback(
    async (range: { from: string; to: string }) => {
      const res = await fetch(
        `/api/public/bookings/${encodeURIComponent(token)}/slots?from=${range.from}&to=${range.to}`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error('Could not load times');
      return (await res.json()) as {
        timezone: string;
        days: Array<{
          date: string;
          slots: Array<{ start: string; end: string; remaining: number }>;
        }>;
      };
    },
    [token],
  );

  async function reschedule() {
    if (!chosen) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/public/bookings/${encodeURIComponent(token)}/reschedule`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start: chosen }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
      } & Booking;
      if (!res.ok) throw new Error(body.message ?? 'Could not move the booking.');
      setBooking(body);
      setMode('view');
      setChosen(null);
      toast.success('Your booking has been moved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reschedule');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (
      !window.confirm(
        'Cancel this booking? You will need to book again if you change your mind.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `/api/public/bookings/${encodeURIComponent(token)}/cancel`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) throw new Error('Could not cancel');
      const next = (await res.json()) as Booking;
      setBooking(next);
      // Drop the browser's memory of it too, or the form would go on
      // offering "you already have a booking" for a cancelled one — and
      // leave its manage token sitting in storage.
      forgetBookingByManageUrl(token);
      toast.success('Your booking has been cancelled.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Finding your booking…
      </div>
    );
  }

  if (notFound || !booking) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <CalendarX className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          We couldn’t find that booking
        </p>
        <p className="mx-auto max-w-sm text-xs text-muted-foreground">
          The link may be incomplete, or the booking may have been removed.
          Please contact the business directly.
        </p>
      </div>
    );
  }

  const cancelled = booking.status === 'cancelled';

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div
          className={
            cancelled
              ? 'flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'
              : 'flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-accent-green'
          }
        >
          {cancelled ? (
            <XCircle className="h-6 w-6" />
          ) : (
            <CalendarCheck className="h-6 w-6" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {booking.form_name}
          </p>
          <p
            className={
              cancelled
                ? 'text-sm text-muted-foreground line-through'
                : 'text-sm text-foreground'
            }
          >
            {formatWhen(booking.starts_at, booking.timezone)}
          </p>
          <p className="text-xs text-muted-foreground">({booking.timezone})</p>
          {cancelled && (
            <p className="mt-1 text-xs font-medium text-muted-foreground">
              This booking is cancelled.
            </p>
          )}
        </div>
      </div>

      {/* A refresh straight after booking now LANDS here, so this is
          where the customer expects to find the call — it used to exist
          only on the confirmation screen they had just lost. */}
      {!cancelled && booking.meeting_url && (
        <a
          href={booking.meeting_url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-muted/40"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Video className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              Join with Google Meet
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {booking.meeting_url.replace(/^https?:\/\//, '')}
            </span>
          </span>
        </a>
      )}

      {!cancelled && mode === 'view' && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMode('reschedule')}
            disabled={busy}
          >
            <RotateCcw className="size-4" />
            Change time
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={cancel}
            disabled={busy}
            className="text-destructive hover:text-destructive"
          >
            <XCircle className="size-4" />
            Cancel booking
          </Button>
        </div>
      )}

      {!cancelled && mode === 'reschedule' && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-foreground">Pick a new time</p>
          <SlotPicker
            fetchSlots={fetchSlots}
            value={chosen}
            onChange={setChosen}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={reschedule} disabled={!chosen || busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Confirm new time
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMode('view');
                setChosen(null);
              }}
              disabled={busy}
            >
              Keep current time
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatWhen(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  });
}
