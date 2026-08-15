-- 085_booking_calendar_sync.sql
--
-- Google Calendar as a source of truth for availability, and a Meet link
-- on every booking that wants one.
--
-- WHY ONLY TWO COLUMNS
--   The connection itself already lives in `app_connections` (082) and the
--   per-form choice (which connection, which calendar, block-busy,
--   create-event, add-meet) goes in the existing `forms.availability` JSON
--   — it IS availability configuration, and putting it there keeps one
--   parser (`parseAvailability`) as the single gate on a malformed config.
--   What genuinely needs columns is the RESULT of a booking: the event we
--   created and the link we handed the customer.
--
-- ⚠️ NULLABLE, AND THAT IS THE DESIGN
--   Calendar sync is best-effort and must never be able to lose a booking.
--   Google being down, a revoked token or a `needs_reauth` connection all
--   leave these NULL on a booking that is otherwise completely valid — the
--   customer has their slot and the business has the row. A NOT NULL here
--   would turn somebody else's outage into our failed checkout.
--
--   The same reasoning is why there is no unique constraint on
--   `calendar_event_id`: a retry that creates a second event is a
--   duplicate in Google's calendar, which a human can delete, whereas a
--   constraint violation would roll back a booking the customer has
--   already been told is confirmed.

ALTER TABLE public.form_bookings
  ADD COLUMN IF NOT EXISTS calendar_event_id text,
  ADD COLUMN IF NOT EXISTS meeting_url text;

COMMENT ON COLUMN public.form_bookings.calendar_event_id IS
  'Google Calendar event id, when the form syncs to a calendar. NULL when '
  'sync is off or the call failed — a booking is never lost to Google being '
  'unavailable. Used to move the event on reschedule and remove it on cancel.';

COMMENT ON COLUMN public.form_bookings.meeting_url IS
  'Google Meet link created with the event. Shown on the confirmation and '
  'in the manage-booking page. NULL when the form does not add Meet links.';

-- Reschedule and cancel look a booking up by its manage token and then
-- need its event id; the token is already unique so no index is needed for
-- that path. This partial index serves the reverse question — "which
-- booking is this calendar event?" — which is what any future two-way sync
-- would start from, and it stays small because most rows are NULL.
CREATE INDEX IF NOT EXISTS form_bookings_calendar_event_idx
  ON public.form_bookings (calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;
