-- ============================================================
-- 055_form_bookings.sql — a form can take a booking.
--
-- WHAT THIS REPLACED, AND WHY
--   An earlier draft of this feature was a full booking product:
--   `appointment_types`, `availability_rules`, `availability_exceptions`,
--   its own service module, its own reminder queue, its own nav section.
--   That was the wrong shape for this app. It duplicated the form builder
--   (two field systems, two submission paths, two validators) to collect
--   one thing, and the dashboard half was never finished.
--
--   A booking IS a form. It asks a few questions and one of them happens
--   to be "when". So the whole feature is:
--
--     * one new field type — `slot_picker` — in the existing builder
--     * `forms.availability`, describing when slots exist
--     * this table, recording the slots that got taken
--
--   Everything else already exists and is reused unchanged: validation,
--   the shared renderer, the hosted page, submissions, contact resolution,
--   and the `form_submitted` automation trigger — which is how a
--   confirmation gets sent, a tag gets added and the team gets notified.
--   No bespoke reminder queue, no second notification path.
--
-- SO WHY A TABLE AT ALL, IF A BOOKING IS JUST A SUBMISSION?
--   Two things a submission cannot do:
--
--     1. Stop two people taking the last slot. `form_submissions.data` is
--        opaque JSONB — Postgres cannot constrain "no two rows overlap in
--        time" through it. Read-then-write in application code has a window
--        between the read and the write, and no amount of care in TypeScript
--        closes it. A dedicated table with an EXCLUDE constraint makes it
--        impossible under any concurrency.
--     2. Be rescheduled or cancelled by the customer, which needs a stable
--        row with a token and a status.
--
--   So: the submission remains the record of what was asked and answered;
--   this table is the record of a reserved slot.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Needed by the EXCLUDE constraint below: it combines an equality operator
-- on a uuid with an overlap operator on a range inside one GiST index, and
-- core GiST has no uuid opclass.
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ============================================================
-- 1) forms.availability — when slots exist
-- ============================================================
--
-- On `forms` rather than in its own table for the same reason `fields` is
-- JSONB: it is read whole to compute slots and written whole by the
-- settings panel, and no query ever filters on it. A relational
-- availability_rules table would buy an ordering column and a
-- delete-orphans path in exchange for nothing.
--
-- NULL means "this form takes no bookings", which is every existing form.
-- The slot engine treats a form with a slot_picker field but no
-- availability as having no slots — visible and fixable, rather than
-- silently offering every hour of every day.

ALTER TABLE forms
  ADD COLUMN IF NOT EXISTS availability JSONB;

COMMENT ON COLUMN forms.availability IS
  'When this form''s slot_picker offers slots. Shape: { timezone, slot_minutes, buffer_minutes, min_notice_minutes, window_days, capacity, windows: [{ weekday, start, end }], blackout_dates: [] }. NULL = the form takes no bookings. Read whole by slot-engine.util.ts; nothing filters on it.';


-- ============================================================
-- 2) form_bookings — the slots that got taken
-- ============================================================

CREATE TABLE IF NOT EXISTS form_bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- RESTRICT, unlike form_submissions.form_id which CASCADEs: deleting a
  -- form that has live bookings on it should fail loudly rather than
  -- silently cancelling appointments people are expecting to attend.
  -- Archiving the form is the supported way to retire it, and that leaves
  -- existing bookings intact.
  form_id       uuid NOT NULL REFERENCES forms(id) ON DELETE RESTRICT,

  -- The submission that made this booking, carrying the answers to
  -- whatever else the form asked. SET NULL rather than CASCADE so purging
  -- old submissions never silently frees a slot someone is still expecting
  -- to turn up for.
  submission_id uuid REFERENCES form_submissions(id) ON DELETE SET NULL,

  contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Set when booked from inside the widget, so a confirmation automation
  -- can reply in the thread the visitor is already in.
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,

  -- Absolute instants: what you need to order bookings, detect overlaps and
  -- schedule reminders.
  starts_at     TIMESTAMPTZ NOT NULL,
  -- Stored, not derived from the form's current slot_minutes. Recomputing
  -- from live settings would silently rewrite past bookings the moment
  -- someone changed the slot length.
  ends_at       TIMESTAMPTZ NOT NULL,
  -- The zone the time was agreed in. `starts_at` alone is unambiguous about
  -- WHEN, but not about what was said — after a DST change or a business
  -- relocating, "10am" has to be re-rendered in the original zone to still
  -- read as what the customer booked.
  timezone      TEXT NOT NULL DEFAULT 'UTC',

  status        TEXT NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),

  -- Bearer capability for the public reschedule/cancel page
  -- (/book/manage/<token>). One token covers both actions because they are
  -- the same authorisation — "you are the person who booked this" — and two
  -- would mean two links in every confirmation message.
  manage_token  TEXT NOT NULL UNIQUE,

  notes         TEXT,
  cancelled_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (ends_at > starts_at)
);

COMMENT ON TABLE form_bookings IS
  'A reserved time slot. The paired form_submission holds what was asked and answered; this row holds the reservation, because a submission cannot be constrained against overlaps or carry a reschedule token.';
COMMENT ON COLUMN form_bookings.manage_token IS
  'The only thing between a leaked confirmation link and someone else''s booking, so it is long and random. Covers reschedule and cancel alike.';
COMMENT ON COLUMN form_bookings.ends_at IS
  'Stored rather than derived. Recomputing from the form''s current slot length would rewrite the history of every past booking whenever that setting changed.';

-- The flag the overlap constraint keys on.
--
-- Declared BEFORE the constraint that references it, which is not a style
-- choice: a constraint whose WHERE clause names a column that does not exist
-- yet fails outright, and on a fresh database this file would not apply at all.
--
-- Denormalised from `forms.availability.capacity` because an EXCLUDE
-- constraint cannot join to another table — it can only see the row being
-- written. The booking service sets it from the form at insert time.
ALTER TABLE form_bookings
  ADD COLUMN IF NOT EXISTS capacity_group BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN form_bookings.capacity_group IS
  'True when the booking''s form sells multiple seats per slot. Denormalised from forms.availability.capacity because an EXCLUDE constraint cannot join. Rows with this set are exempt from form_bookings_no_overlap and are counted transactionally instead.';


-- ============================================================
-- THE DOUBLE-BOOKING GUARD
-- ============================================================
--
-- "For a given form, no two live bookings may cover overlapping time."
--
--   * `WITH =` on form_id scopes it per form, so two different services can
--     be booked at the same time. This is the part that needs btree_gist.
--   * `WITH &&` on the tstzrange is the overlap test. `[)` bounds —
--     start-inclusive, end-exclusive — so 09:00-10:00 and 10:00-11:00 do
--     NOT collide. Inclusive bounds would reject every back-to-back slot.
--   * The WHERE clause is what makes it usable: a cancelled booking must
--     stop blocking its slot, or cancelling would never free anything.
--
-- CAPACITY > 1 IS DELIBERATELY NOT COVERED
--   A class or webinar sells several seats in the same slot, which is
--   overlapping by design. Those forms are excluded here and counted inside a
--   transaction instead — see booking.service. Setting capacity above 1 is
--   therefore an explicit trade of this guarantee for group bookings, not an
--   oversight.
DO $$
BEGIN
  ALTER TABLE form_bookings DROP CONSTRAINT IF EXISTS form_bookings_no_overlap;
  ALTER TABLE form_bookings
    ADD CONSTRAINT form_bookings_no_overlap
    EXCLUDE USING gist (
      form_id WITH =,
      tstzrange(starts_at, ends_at, '[)') WITH &&
    )
    WHERE (status = 'confirmed' AND capacity_group IS FALSE);
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

-- "This form's live bookings in a window" — the slot engine's only read.
CREATE INDEX IF NOT EXISTS idx_form_bookings_form_starts
  ON form_bookings (form_id, starts_at)
  WHERE status = 'confirmed';

-- The account's calendar view.
CREATE INDEX IF NOT EXISTS idx_form_bookings_account_starts
  ON form_bookings (account_id, starts_at DESC);

-- "Everything this contact has booked" — the contact timeline.
CREATE INDEX IF NOT EXISTS idx_form_bookings_contact
  ON form_bookings (contact_id, starts_at DESC)
  WHERE contact_id IS NOT NULL;

ALTER TABLE form_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS form_bookings_select ON form_bookings;
CREATE POLICY form_bookings_select ON form_bookings FOR SELECT
  USING (is_account_member(account_id));

-- Update and delete only. No client INSERT policy: every booking arrives
-- through the public endpoint on the server, which computes real
-- availability first. A browser-insertable bookings table would let anyone
-- reserve any time, including times the business is closed.
DROP POLICY IF EXISTS form_bookings_update ON form_bookings;
CREATE POLICY form_bookings_update ON form_bookings FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS form_bookings_delete ON form_bookings;
CREATE POLICY form_bookings_delete ON form_bookings FOR DELETE
  USING (is_account_member(account_id, 'admin'));
