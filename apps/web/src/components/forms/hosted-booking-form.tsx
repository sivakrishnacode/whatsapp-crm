'use client';

import { useCallback, useState } from 'react';
import { CalendarCheck, Copy, ExternalLink, Video } from 'lucide-react';
import { toast } from 'sonner';

import FormRenderer, {
  type FormSubmitPayload,
  type FormSubmitResult,
  type PublicForm,
} from './form-renderer';

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

      if (body.booking) setConfirmed(body.booking);

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
    <FormRenderer
      form={form}
      source="hosted"
      slug={slug}
      fetchSlots={fetchSlots}
      onSubmit={submit}
    />
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
