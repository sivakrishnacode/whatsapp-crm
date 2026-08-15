'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { CalendarCheck, Copy, ExternalLink, Video, X } from 'lucide-react';
import { toast } from 'sonner';

import FormRenderer, {
  type FormSubmitPayload,
  type FormSubmitResult,
  type PublicForm,
} from './form-renderer';
import {
  bookingSnapshot,
  rememberBooking,
  serverBookingSnapshot,
  subscribeBooking,
  type RememberedBooking,
} from '@/lib/forms/booking-memory';

interface BookingConfirmation {
  starts_at: string;
  ends_at: string;
  timezone: string;
  manage_url: string;
  /** Present only when the form creates Google Meet links. */
  meeting_url?: string | null;
}

/**
 * The hosted booking page's form.
 *
 * A client component because two things need the browser: loading live slots,
 * and rendering the confirmation with the booked time in a readable form. The
 * form *definition* is still fetched on the server and cached — only
 * availability is per-request, because a cached slot list is a list of times
 * that may already be gone.
 *
 * WHY IT OVERRIDES SUBMIT INSTEAD OF USING THE DEFAULT
 *   The default hosted submit returns the generic success message and the
 *   renderer shows its "thanks" panel. A booking has more to say: which time
 *   was reserved, and the link to change it. Handling the response here lets
 *   the confirmation carry both, which is the difference between a customer
 *   trusting the booking happened and emailing to check.
 */
export function HostedBookingForm({
  form,
  slug,
}: {
  form: PublicForm;
  slug: string;
}) {
  const [confirmed, setConfirmed] = useState<BookingConfirmation | null>(null);
  /**
   * A booking made in this browser earlier.
   *
   * `useSyncExternalStore` rather than an effect: localStorage is an
   * external store, and this is the reader React provides for one. It
   * also fixes hydration by construction — the server snapshot is null,
   * which is exactly what the server rendered.
   */
  const previous = useSyncExternalStore(
    subscribeBooking,
    () => bookingSnapshot(slug),
    serverBookingSnapshot,
  );
  const [dismissed, setDismissed] = useState(false);
  // Read once, at mount. Comparing against the clock during render would
  // be impure and could disagree between passes.
  const [now] = useState(() => Date.now());

  const fetchSlots = useCallback(
    async (range: { from: string; to: string }) => {
      const res = await fetch(
        `/api/public/forms/${encodeURIComponent(slug)}/slots?from=${range.from}&to=${range.to}`,
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
    [slug],
  );

  const submit = useCallback(
    async (payload: FormSubmitPayload): Promise<FormSubmitResult> => {
      const res = await fetch(
        `/api/public/forms/${encodeURIComponent(slug)}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            source: 'hosted',
            meta: {
              pageUrl: window.location.href,
              referrer: document.referrer,
            },
          }),
        },
      );

      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        errors?: Array<{ field_key: string; message: string }>;
        booking?: BookingConfirmation;
        successMessage?: string;
      };

      if (!res.ok) {
        // 409 is the slot race — someone took the time between this visitor
        // loading the list and pressing submit. Surfaced as its own message
        // because the remedy is specific ("pick another time"), not "check
        // your details".
        if (res.status === 409) {
          throw new Error(
            body.message ?? 'That time has just been taken. Please pick another.',
          );
        }
        throw new Error(body.message ?? 'Could not complete your booking.');
      }

      if (body.booking) {
        setConfirmed(body.booking);

        /*
         * Point the address bar at the manage page.
         *
         * THIS, not localStorage, is what makes a refresh safe. The
         * confirmation used to be the only copy of a link the page itself
         * called "the only way back to your booking" — one refresh and
         * the customer could no longer reschedule or cancel. Now a reload
         * lands on /book/manage/<token>, which loads the booking from the
         * server, so it also works on another device and shows a
         * cancelled booking as cancelled rather than a stale "you're
         * booked".
         *
         * `replaceState` rather than a router navigation: the visitor
         * keeps the confirmation they are looking at (with the Meet link),
         * and Back does not return to a filled-in form that has already
         * been submitted.
         */
        if (typeof window !== 'undefined' && body.booking.manage_url) {
          try {
            window.history.replaceState(null, '', body.booking.manage_url);
          } catch {
            // A cross-origin manage URL would throw. The confirmation on
            // screen is unaffected, so there is nothing to recover from.
          }
        }

        rememberBooking(slug, {
          manageUrl: body.booking.manage_url,
          startsAt: body.booking.starts_at,
          timezone: body.booking.timezone,
          meetingUrl: body.booking.meeting_url ?? null,
        });
      }

      return {
        successMode: 'message',
        successMessage: body.successMessage ?? 'Your booking is confirmed.',
        redirectUrl: null,
      };
    },
    [slug],
  );

  if (confirmed) {
    return <Confirmation booking={confirmed} />;
  }

  return (
    <>
      {/* Someone who booked here before and came back to the form's own
          link. Deliberately a banner ABOVE the form rather than a
          replacement for it: booking a second appointment is a normal
          thing to want, and hiding the form would make that impossible. */}
      {previous && !dismissed && (
        <PreviousBooking
          booking={previous}
          past={new Date(previous.startsAt).getTime() < now}
          onDismiss={() => setDismissed(true)}
        />
      )}

      <FormRenderer
        form={form}
        source="hosted"
        slug={slug}
        fetchSlots={fetchSlots}
        onSubmit={submit}
      />
    </>
  );
}

/**
 * "You already have a booking here" — shown above the form on a return
 * visit in the same browser.
 *
 * Says WHEN and links back, rather than reproducing the confirmation:
 * the manage page is the live view, and this entry may be days old and
 * describe a booking that has since been moved or cancelled elsewhere.
 */
function PreviousBooking({
  booking,
  past,
  onDismiss,
}: {
  booking: RememberedBooking;
  past: boolean;
  onDismiss: () => void;
}) {
  const when = new Date(booking.startsAt).toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: booking.timezone,
  });
  return (
    <div className="mb-6 w-full rounded-[var(--form-radius)] border border-border bg-muted/40 p-4">
      <div className="flex items-start gap-3">
        <CalendarCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-green" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {past ? 'You had a booking here' : 'You already have a booking'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {when} ({booking.timezone})
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <a
              href={booking.manageUrl}
              className="text-xs font-medium underline underline-offset-2"
              style={{ color: 'var(--form-accent, var(--primary))' }}
            >
              View or change it
            </a>
            {booking.meetingUrl && !past && (
              <a
                href={booking.meetingUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Join with Meet
              </a>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-3 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground/80">
        Booking again below will create a second appointment.
      </p>
    </div>
  );
}

function Confirmation({ booking }: { booking: BookingConfirmation }) {
  const when = new Date(booking.starts_at).toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: booking.timezone,
  });

  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 text-accent-green">
        <CalendarCheck className="h-9 w-9" />
      </div>
      <div>
        <p className="text-xl font-semibold text-foreground">You’re booked</p>
        <p className="mt-1 text-sm text-muted-foreground">{when}</p>
        <p className="text-xs text-muted-foreground">({booking.timezone})</p>
      </div>

      {booking.meeting_url && (
        // Above the manage link on purpose: joining the call is what the
        // customer came for, and a link they have to hunt for at the
        // bottom of a confirmation is a call they turn up late to.
        <a
          href={booking.meeting_url}
          target="_blank"
          rel="noreferrer"
          className="flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/40"
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{
              backgroundColor: 'var(--form-accent, var(--primary))',
              color: 'var(--form-accent-fg, var(--primary-foreground))',
            }}
          >
            <Video className="h-4 w-4" />
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

      <div className="w-full max-w-sm rounded-xl border border-border bg-muted/30 p-4 text-left">
        <p className="text-xs font-medium text-foreground">
          Need to change or cancel?
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Keep this link — it’s the only way back to your booking.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1.5 text-[11px]">
            {booking.manage_url}
          </code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(booking.manage_url);
              toast.success('Link copied.');
            }}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-background"
            aria-label="Copy link"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <a
            href={booking.manage_url}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-background"
            aria-label="Open booking"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
