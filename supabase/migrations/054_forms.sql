-- ============================================================
-- 054_forms.sql — a form builder, usable from every channel.
--
-- WHY FORMS ARE NOT A WEB-CHANNEL FEATURE
--   They arrive alongside the web widget (a pre-chat form and a hosted
--   lead form are the two things a widget is installed next to), but a
--   form link gets sent over WhatsApp by an automation, a submission
--   creates a contact that the WhatsApp inbox then answers, and the
--   public v1 API will want to read submissions. Scoping this to one
--   channel would be the same mistake automations made before migration
--   052 — so `forms` is account-scoped and channel-agnostic, and
--   `form_submissions.source` records where each one came from.
--
-- WHY FIELDS ARE JSONB AND NOT A form_fields TABLE
--   `flows` and `automations` use relational children (`flow_nodes`,
--   `automation_steps`) because their ENGINES walk them one row at a
--   time — a run resumes at node N. A form has no engine: it is read
--   whole to render and written whole to save. Relational children would
--   buy nothing and cost an ordering column, a delete-orphans path, and a
--   multi-statement save that can half-apply.
--
--   The tradeoff is that "which forms map a field to custom_field X" is
--   not indexable. That query does not exist in the product, and if it
--   ever does, a GIN index on `fields` answers it.
--
-- HOW A FIELD REACHES A CONTACT
--   Each field carries an optional `mapping`, which is either a built-in
--   contact column (`name` | `email` | `phone` | `company`) or
--   `custom:<custom_field_id>`. That `custom:` prefix is deliberately the
--   same convention `automation_steps.config.field` already uses for
--   update_contact_field — one rule to learn, one parser to get right,
--   and the two features cannot drift.
--
-- Idempotent — safe to re-run.
-- ============================================================


-- ============================================================
-- 1) forms
-- ============================================================

CREATE TABLE IF NOT EXISTS forms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name             TEXT NOT NULL,
  description      TEXT,

  -- Public URL segment: /f/<slug>. Unique per account rather than
  -- globally, so two tenants may both have a "contact-us" — and because a
  -- globally unique slug would leak which names are taken across tenants.
  slug             TEXT NOT NULL,

  -- 'form' collects answers; 'booking' additionally carries an
  -- appointment_slot field and creates an appointment on submit (055).
  -- One table rather than two because they share the entire builder,
  -- renderer, validation and submission path — the difference is one
  -- field type and one post-submit action.
  kind             TEXT NOT NULL DEFAULT 'form'
                     CHECK (kind IN ('form', 'booking')),

  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'published', 'archived')),

  -- Ordered array of field objects. See form.types.ts for the shape;
  -- validated server-side by form-validate.ts on every submission, which
  -- is the authority — client validation is UX only.
  fields           JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Submit button label, success behaviour, redirect target, consent
  -- copy, theme, spam controls. Read and written whole, never filtered on.
  settings         JSONB NOT NULL DEFAULT '{
    "submit_label": "Submit",
    "success_mode": "message",
    "success_message": "Thanks — we have got your details.",
    "redirect_url": null,
    "honeypot": true,
    "min_seconds": 2,
    "captcha": false
  }'::jsonb,

  -- Who to tell. Separate from `settings` because it is the one part an
  -- admin edits for operational reasons rather than design reasons.
  notify           JSONB NOT NULL DEFAULT '{"emails": [], "in_app": true}'::jsonb,

  -- Denormalised counter, incremented on submit. The alternative is
  -- COUNT(*) over form_submissions on every render of the forms list,
  -- which is a table scan per row of a list page.
  submission_count INTEGER NOT NULL DEFAULT 0,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (account_id, slug)
);

COMMENT ON TABLE forms IS
  'Account-scoped, channel-agnostic form definitions. Rendered on a hosted page (/f/<slug>), embedded in a customer site, or inline in the web widget. NOT a web-channel feature — automations send form links over WhatsApp.';
COMMENT ON COLUMN forms.slug IS
  'Public URL segment. Unique per account, not globally: two tenants may both want "contact-us", and a global namespace would leak which slugs other tenants hold.';
COMMENT ON COLUMN forms.fields IS
  'Ordered array of field definitions. Each may carry a `mapping` of a contact column (name|email|phone|company) or `custom:<custom_field_id>` — the same prefix convention as automation_steps update_contact_field, deliberately, so there is one rule and one parser.';
COMMENT ON COLUMN forms.submission_count IS
  'Denormalised. Avoids a COUNT(*) over form_submissions for every row of the forms list. Authoritative count is always the submissions table; treat drift as cosmetic.';

CREATE INDEX IF NOT EXISTS idx_forms_account_updated
  ON forms (account_id, updated_at DESC);

-- The public render path's only lookup: slug → published form.
CREATE INDEX IF NOT EXISTS idx_forms_account_slug_published
  ON forms (account_id, slug)
  WHERE status = 'published';

ALTER TABLE forms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS forms_select ON forms;
CREATE POLICY forms_select ON forms FOR SELECT
  USING (is_account_member(account_id));

-- Agent-level write, matching automations and flows: building a form is
-- ordinary day-to-day work, not an admin act.
DROP POLICY IF EXISTS forms_write ON forms;
CREATE POLICY forms_write ON forms FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));


-- ============================================================
-- 2) form_submissions
-- ============================================================

CREATE TABLE IF NOT EXISTS form_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- CASCADE: a deleted form's submissions have no meaning without the
  -- questions they answered. Exporting before deletion is a product
  -- concern, not a schema one.
  form_id         uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,

  -- SET NULL, unlike form_id: a submission is evidence that someone got
  -- in touch, and that stays true after the contact record is removed.
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,

  -- Set only when submitted from inside the widget, which is what lets an
  -- automation triggered by the submission reply in the same thread
  -- instead of opening a new one.
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,

  -- The answers, keyed by field_key. JSONB because the shape is the
  -- form's shape, which differs per form and changes over time — and
  -- because a submission must remain readable after the form is edited.
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Attribution + abuse forensics: referrer, utm, page_url, user_agent,
  -- ip_hash. Hashed IP only, same reasoning as web_sessions.
  meta            JSONB,

  source          TEXT NOT NULL DEFAULT 'hosted'
                    CHECK (source IN ('hosted', 'embed', 'widget', 'whatsapp_flow', 'api', 'automation')),

  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'read', 'spam')),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE form_submissions IS
  'One filled-in form. `data` is keyed by field_key and stays readable after the form definition changes — a submission is a historical record, not a view of the current form.';
COMMENT ON COLUMN form_submissions.conversation_id IS
  'Set only for widget submissions. It is what lets a form_submitted automation reply in the thread the visitor is already in rather than starting a new one.';
COMMENT ON COLUMN form_submissions.contact_id IS
  'NULL when no identity could be resolved (a form with no email/phone field). SET NULL on contact deletion — the submission is evidence someone made contact, which survives the contact record.';

-- "Recent submissions across the account" — the notifications surface.
CREATE INDEX IF NOT EXISTS idx_form_submissions_account_created
  ON form_submissions (account_id, created_at DESC);

-- "This form's submissions" — the submissions table view.
CREATE INDEX IF NOT EXISTS idx_form_submissions_form_created
  ON form_submissions (form_id, created_at DESC);

-- "Everything this contact ever sent us" — the contact timeline.
CREATE INDEX IF NOT EXISTS idx_form_submissions_contact
  ON form_submissions (contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS form_submissions_select ON form_submissions;
CREATE POLICY form_submissions_select ON form_submissions FOR SELECT
  USING (is_account_member(account_id));

-- Update only (marking read/spam). No client INSERT policy: every
-- submission arrives through the public endpoint on the server, which
-- validates, spam-checks and rate-limits first. A browser-insertable
-- submissions table would let anyone forge leads into a tenant's CRM.
DROP POLICY IF EXISTS form_submissions_update ON form_submissions;
CREATE POLICY form_submissions_update ON form_submissions FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS form_submissions_delete ON form_submissions;
CREATE POLICY form_submissions_delete ON form_submissions FOR DELETE
  USING (is_account_member(account_id, 'admin'));


-- ============================================================
-- 3) web_config → forms (the columns 053 deliberately deferred)
-- ============================================================
--
-- 053 left these out because `forms` did not exist yet and two bare uuids
-- that look like foreign keys but aren't is worse than waiting a migration.
--
-- SET NULL rather than RESTRICT: deleting a form that happens to be wired
-- up as a pre-chat form should not fail with a constraint error. The
-- widget treats NULL as "no pre-chat form", which is a working state.

ALTER TABLE web_config
  ADD COLUMN IF NOT EXISTS prechat_form_id uuid REFERENCES forms(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offline_form_id uuid REFERENCES forms(id) ON DELETE SET NULL;

COMMENT ON COLUMN web_config.prechat_form_id IS
  'Form shown before the chat starts, to capture a name/email/phone. NULL = start chatting immediately. Capturing a phone or email here is what upgrades an anonymous web_visitor_id contact into a durable one.';
COMMENT ON COLUMN web_config.offline_form_id IS
  'Form offered instead of live chat outside business hours. NULL = let the visitor send a message anyway (it waits in the inbox).';


-- ============================================================
-- 4) form-uploads bucket — file fields
-- ============================================================
--
-- PRIVATE, unlike web-media. A web-media object is a chat attachment
-- rendered inline in a widget by an <img src>, so public read with an
-- unguessable path is the right trade. A form file upload is a CV, an ID
-- photo, a signed contract — submitted once by one person to one business,
-- and never rendered in a public page. There is no convenience to buy with
-- public read here, so it stays private and the dashboard mints a signed
-- URL when an agent opens it.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'form-uploads',
  'form-uploads',
  FALSE,
  10485760, -- 10 MB. Lower than chat media: a form file field is a
            -- document, and an anonymous public upload surface should be
            -- the tightest cap that still does the job.
  ARRAY[
    'image/png', 'image/jpeg', 'image/webp', 'image/heic',
    'application/pdf',
    'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Members of the owning account may read. The path's first segment is the
-- account id, so this scopes reads to the tenant that received the file.
DROP POLICY IF EXISTS "Form uploads readable by account members" ON storage.objects;
CREATE POLICY "Form uploads readable by account members"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'form-uploads'
    AND is_account_member((storage.foldername(name))[1]::uuid)
  );

-- No client write policy: uploads go through the API's endpoint, which
-- validates size and MIME with the service-role key.
