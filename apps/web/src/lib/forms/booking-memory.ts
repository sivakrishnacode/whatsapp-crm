/**
 * Remembering a booking in the visitor's own browser.
 *
 * WHY THIS EXISTS
 *   The confirmation tells the customer their manage link is "the only
 *   way back to your booking", and that was literally true: refresh the
 *   page and it was gone, along with any ability to reschedule or cancel.
 *
 * ⚠️ THIS IS THE FALLBACK, NOT THE FIX.
 *   The real recovery is the URL — `HostedBookingForm` rewrites the
 *   address bar to the manage link on success, so a refresh lands on a
 *   page that loads the booking FROM THE SERVER. That works across
 *   devices, survives a cleared browser, and shows a cancelled booking as
 *   cancelled. This module only covers "came back to the form's own link
 *   later, in the same browser", where there is no URL to go on.
 *
 * ⚠️ WHAT IS STORED IS A BEARER CREDENTIAL.
 *   The manage token authorises rescheduling and cancelling with no login
 *   — that is deliberate (see BookingsPublicController), but it means
 *   anyone using this browser afterwards can act on the booking. So:
 *   the entry expires, it is dropped the moment the appointment has
 *   passed, cancelling clears it, and the banner it powers is dismissible.
 *   It is never written for a booking made inside the dashboard preview.
 */

const KEY_PREFIX = 'converse360.booking.';

/** Dropped this long after the appointment, whatever else happens. */
const RETAIN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface RememberedBooking {
  /** Absolute URL of the manage page. Carries the token. */
  manageUrl: string;
  /** ISO instant of the appointment. */
  startsAt: string;
  timezone: string;
  /** Present only when the form creates Meet links. */
  meetingUrl?: string | null;
}

function key(slug: string): string {
  return `${KEY_PREFIX}${slug}`;
}

/** Storage can throw (Safari private mode, disabled cookies). Never fatal. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function rememberBooking(
  slug: string,
  booking: RememberedBooking,
): void {
  if (typeof window === 'undefined') return;
  safe(
    () => window.localStorage.setItem(key(slug), JSON.stringify(booking)),
    undefined,
  );
}

export function forgetBooking(slug: string): void {
  if (typeof window === 'undefined') return;
  safe(() => window.localStorage.removeItem(key(slug)), undefined);
}

/**
 * The remembered booking, if there is a live one.
 *
 * Returns null once the appointment is far enough past to be irrelevant,
 * and CLEANS UP as it goes — an expired entry is deleted rather than
 * merely ignored, so a stale token does not sit in storage indefinitely.
 */
export function recallBooking(slug: string): RememberedBooking | null {
  if (typeof window === 'undefined') return null;

  return safe(() => {
    const raw = window.localStorage.getItem(key(slug));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<RememberedBooking>;
    if (!parsed?.manageUrl || !parsed?.startsAt) {
      forgetBooking(slug);
      return null;
    }

    const startsAt = new Date(parsed.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      forgetBooking(slug);
      return null;
    }
    if (Date.now() - startsAt.getTime() > RETAIN_AFTER_MS) {
      forgetBooking(slug);
      return null;
    }

    return {
      manageUrl: parsed.manageUrl,
      startsAt: parsed.startsAt,
      timezone: parsed.timezone ?? 'UTC',
      meetingUrl: parsed.meetingUrl ?? null,
    };
  }, null);
}

/**
 * Forget whichever entry holds this manage token.
 *
 * The manage page knows the token but not the form's slug, so it cannot
 * build the key. Scanning the handful of `converse360.booking.*` entries
 * is cheap and keeps the storage layout private to this module — the
 * alternative was passing the slug through the manage URL, which would
 * put it in the address bar for no reason.
 */
export function forgetBookingByManageUrl(token: string): void {
  if (typeof window === 'undefined' || !token) return;

  safe(() => {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (!k?.startsWith(KEY_PREFIX)) continue;
      const raw = window.localStorage.getItem(k);
      if (raw?.includes(token)) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  }, undefined);
}

// ---------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------

/**
 * localStorage IS an external store, so the React-blessed way to read it
 * is `useSyncExternalStore` rather than an effect that calls setState.
 * That also gets hydration right for free: `serverBookingSnapshot`
 * returns null, which is exactly what the server rendered.
 *
 * The snapshot MUST be referentially stable while the underlying string
 * is unchanged, or `useSyncExternalStore` re-renders forever — hence the
 * cache keyed on the raw JSON.
 */
let snapshotCache: {
  slug: string;
  raw: string | null;
  value: RememberedBooking | null;
} | null = null;

export function subscribeBooking(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  // `storage` fires for OTHER tabs, which is the case worth reacting to:
  // cancelling in one tab should stop the banner in another.
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

export function bookingSnapshot(slug: string): RememberedBooking | null {
  const raw = safe(() => window.localStorage.getItem(key(slug)), null);
  if (snapshotCache && snapshotCache.slug === slug && snapshotCache.raw === raw) {
    return snapshotCache.value;
  }
  const value = recallBooking(slug);
  snapshotCache = { slug, raw, value };
  return value;
}

/** Always null: the server has no browser storage to read. */
export function serverBookingSnapshot(): RememberedBooking | null {
  return null;
}
