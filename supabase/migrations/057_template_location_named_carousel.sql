-- ============================================================
-- 057_template_location_named_carousel.sql — widen the template
-- builder to three Meta features it could not express before:
-- LOCATION headers, NAMED parameters, and CAROUSEL cards.
--
-- LOCATION HEADERS
--   001_initial_schema.sql pinned header_type to
--   ('text','image','video','document') with an inline CHECK, so a
--   LOCATION-header template could not even be stored — including one
--   pulled down by "Sync from Meta", which is how most accounts get
--   them (they were previously only creatable in WhatsApp Manager).
--   The constraint is re-created by name here so the next widening is
--   a one-line ALTER instead of another dynamic lookup.
--
--   Unlike media headers, a LOCATION header carries NO creation-time
--   example — Meta wants the component bare and takes the pin at send
--   time. That is why no companion column is added: latitude,
--   longitude, name and address are per-send values, not template
--   properties, and they arrive through SendTimeParams.headerLocation.
--
-- PARAMETER_FORMAT
--   Meta lets a template declare `parameter_format: NAMED`, which
--   swaps `{{1}}` for `{{customer_name}}`. It is a whole-template
--   property, not a per-component one, and Meta rejects a template
--   that mixes the two schemes.
--
--   Existing rows are POSITIONAL by definition — that is the only
--   thing we have ever submitted — so the column defaults to
--   'POSITIONAL' and is NOT NULL. Code still treats a null/absent
--   value as POSITIONAL (see template-validators.util.ts) because the
--   public v1 API accepts payloads that omit the field.
--
--   NOT stored per variable: the names live in the body/header text
--   itself, and their order of first appearance is the mapping onto
--   sample_values.body — so `sample_values` keeps its existing
--   {body: string[], header: string[]} shape and no data migrates.
--
-- CARDS
--   A CAROUSEL template is an outer body plus 1-10 cards, each with
--   its own media header, body and buttons. That is a repeating
--   nested structure, so it goes in JSONB rather than becoming ten
--   sets of flat columns.
--
--   Meta's uniformity rule (every card must share the same header
--   format and the same button shape) is enforced in
--   template-validators.util.ts, not here: a JSONB CHECK cannot
--   express "all elements agree with each other" without a subquery,
--   and a constraint violation would surface as an opaque 400 rather
--   than "card #3 has 1 button but card #1 has 2".
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. header_type: allow 'location'
-- ------------------------------------------------------------

-- The original constraint was declared inline, so its name is
-- Postgres-generated. Drop whatever CHECK currently governs
-- header_type rather than guessing the name.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  FOR con_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.message_templates'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%header_type%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.message_templates DROP CONSTRAINT %I',
      con_name
    );
  END LOOP;
END $$;

ALTER TABLE public.message_templates
  ADD CONSTRAINT message_templates_header_type_check
  CHECK (
    header_type IS NULL
    OR header_type IN ('text', 'image', 'video', 'document', 'location')
  );

-- ------------------------------------------------------------
-- 2. parameter_format: POSITIONAL {{1}} vs NAMED {{customer_name}}
-- ------------------------------------------------------------

ALTER TABLE public.message_templates
  ADD COLUMN IF NOT EXISTS parameter_format TEXT NOT NULL DEFAULT 'POSITIONAL';

ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_parameter_format_check;

ALTER TABLE public.message_templates
  ADD CONSTRAINT message_templates_parameter_format_check
  CHECK (parameter_format IN ('POSITIONAL', 'NAMED'));

COMMENT ON COLUMN public.message_templates.parameter_format IS
  'Meta parameter_format. POSITIONAL = {{1}}, NAMED = {{customer_name}}. Fixed at creation; Meta rejects a mix within one template.';

-- ------------------------------------------------------------
-- 3. cards: CAROUSEL cards, 1-10 per template
-- ------------------------------------------------------------

ALTER TABLE public.message_templates
  ADD COLUMN IF NOT EXISTS cards JSONB;

-- Shape and per-card rules are validated in application code; the only
-- thing worth pinning in the database is that this is an array and
-- that it respects Meta's hard 10-card ceiling, because a violation
-- there means a malformed write, not bad user input.
ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_cards_check;

ALTER TABLE public.message_templates
  ADD CONSTRAINT message_templates_cards_check
  CHECK (
    cards IS NULL
    OR (
      jsonb_typeof(cards) = 'array'
      AND jsonb_array_length(cards) BETWEEN 1 AND 10
    )
  );

COMMENT ON COLUMN public.message_templates.cards IS
  'CAROUSEL cards: [{header_format, header_handle, header_media_url, body_text, body_samples, buttons}]. NULL for non-carousel templates.';
