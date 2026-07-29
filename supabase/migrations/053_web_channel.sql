-- ============================================================
-- 053_web_channel.sql — the website chat widget becomes a third
-- first-class channel.
--
-- WHY THIS IS THE SMALLEST MIGRATION OF THE THREE CHANNELS
--   050 argued for a shared core (contacts / conversations / messages
--   discriminated by `channel`) rather than per-platform mirrors, and
--   that argument pays off here: adding Web is one more value in a CHECK
--   constraint, one more identity column, and one config table. The
--   inbox, AI auto-reply, Automations, Flows and the public v1 API all
--   read the shared tables and need no migration at all.
--
-- WEB IS THE FIRST CHANNEL WE OWN END TO END
--   WhatsApp and Instagram are Meta's transports: they impose a 24-hour
--   customer-service window, they require pre-approved templates to
--   re-engage outside it, and they decide what a "delivered" receipt
--   means. None of that applies to a widget on the customer's own
--   website — we are the transport. Two consequences are encoded here:
--
--     * There is NO messaging window. `conversations.last_inbound_at` is
--       still maintained (the inbox sorts on it) but nothing gates a
--       send on it. See CHANNEL_CAPABILITIES.web.replyWindowHours = null
--       in apps/api/src/common/messaging/channel.ts.
--     * A delivery receipt is truthful for the first time, because the
--       SSE stream either accepted the frame or it did not.
--
--   The flip side is that a web visitor cannot be *reached* once they
--   close the tab. That is why broadcasts are impossible on this channel
--   and why appointment reminders for web-only contacts have to fall
--   back to email.
--
-- IDENTITY: web_visitor_id
--   An anonymous visitor has no phone and no IGSID, so they get an
--   opaque UUID we mint on first contact and persist in their browser.
--   Same shape as the IGSID: nullable column, partial unique index,
--   added to the identity CHECK.
--
--   Unlike Instagram, web identity CAN be legitimately merged into an
--   existing contact — but only when the visitor *tells* us a phone or
--   email through a pre-chat or hosted form. 050 refused to guess that
--   two identities were the same human; capturing it from a form input
--   is not guessing. That merge lives in application code
--   (form-contact-resolver.service.ts), not here.
--
-- WHAT IS DELIBERATELY NOT IN THIS FILE
--   `web_config.prechat_form_id` / `offline_form_id` are added in
--   054_forms.sql, not here, because that is where the `forms` table
--   they reference comes into existence. Adding them now as bare uuids
--   would mean two columns that look like foreign keys, aren't, and
--   can point at nothing.
--
-- Idempotent — safe to re-run.
-- ============================================================


-- ============================================================
-- 1) conversations — 'web' becomes a legal channel
-- ============================================================

-- The whole point of 050 choosing TEXT + CHECK over a Postgres enum:
-- adding a channel is this one statement, with no enum migration and no
-- table lock.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_chk;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_chk
  CHECK (channel IN ('whatsapp', 'instagram', 'web'));

COMMENT ON COLUMN conversations.channel IS
  'Which platform this thread lives on: whatsapp | instagram | web. Every row predating 050 is whatsapp. Note that a channel-agnostic lookup by (account_id, contact_id) can now return any of three threads — every such query must pin the channel (see common/messaging/channel.ts).';


-- ============================================================
-- 2) automations — rules may be scoped to Web
-- ============================================================

-- 052 introduced this array with EMPTY = all channels. Every automation
-- that exists today therefore already applies to Web the moment the
-- send path lands; this only widens what an author may *explicitly*
-- list. Without the widening, saving a Web-scoped automation would fail
-- the CHECK with an opaque constraint-violation error.
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_channels_chk;
ALTER TABLE automations
  ADD CONSTRAINT automations_channels_chk
  CHECK (channels <@ ARRAY['whatsapp', 'instagram', 'web']::TEXT[]);


-- ============================================================
-- 3) contacts — the web visitor identity
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS web_visitor_id TEXT;

COMMENT ON COLUMN contacts.web_visitor_id IS
  'Opaque visitor id we mint on first widget contact and persist in the browser (localStorage, mirrored into the signed session token). Account-scoped, unlike an IGSID — it means nothing outside this tenant. Survives page reloads and new sessions; does NOT survive a cleared browser, which is why capturing a phone or email through the pre-chat form is what makes a web contact durable.';

-- Same posture as idx_contacts_account_igsid: partial, because the vast
-- majority of contacts are WhatsApp-only and carry NULL here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_web_visitor
  ON contacts (account_id, web_visitor_id)
  WHERE web_visitor_id IS NOT NULL;

-- A contact must still be reachable by *something*. Three identities
-- now, any one of which is sufficient. Without this a bug could insert
-- an identity-less row that no channel can address.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_identity_chk;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_identity_chk
  CHECK (
    phone IS NOT NULL
    OR ig_scoped_id IS NOT NULL
    OR web_visitor_id IS NOT NULL
  );


-- ============================================================
-- 4) web_config — one widget per account
-- ============================================================

CREATE TABLE IF NOT EXISTS web_config (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- PUBLIC key. It ships inside a <script> tag on the customer's own
  -- website, so it must be treated as world-readable — it is an
  -- account *locator*, never an authorisation. Globally unique because
  -- the bootstrap endpoint has nothing else to route on, exactly like
  -- instagram_config.ig_user_id.
  widget_key        TEXT NOT NULL UNIQUE,

  -- SECRET, AES-256-GCM at rest (same encrypt()/decrypt() as
  -- whatsapp_config.access_token). Two uses, both server-side only:
  --   * HMAC key for identity verification, so a logged-in visitor on
  --     the customer's site cannot be impersonated by editing JS.
  --   * signing key for the visitor session token.
  -- Rotating it invalidates every live session, which is the point.
  widget_secret     TEXT NOT NULL,

  -- Origins allowed to embed the widget and call the public endpoints.
  -- EMPTY means "not yet configured" and the guard DENIES — the opposite
  -- of the automations.channels convention, deliberately: an empty
  -- allowlist that meant "allow all" would turn every freshly created
  -- account into an open relay.
  allowed_origins   TEXT[] NOT NULL DEFAULT '{}',

  status            TEXT NOT NULL DEFAULT 'disconnected'
                      CHECK (status IN ('disconnected', 'connected', 'disabled')),

  -- Set the first time we serve a bootstrap call from an allowed origin.
  -- This is what "connected" means for a channel with no OAuth: the
  -- snippet is genuinely on a live page, not just copied.
  installed_at      TIMESTAMPTZ,
  last_seen_at      TIMESTAMPTZ,

  -- Launcher + panel appearance. JSONB rather than a dozen columns
  -- because it is read as a whole by the bootstrap endpoint and written
  -- as a whole by the appearance editor; no query ever filters on it.
  appearance        JSONB NOT NULL DEFAULT '{
    "accent": "#2D7FF9",
    "position": "right",
    "theme": "auto",
    "launcher_icon": "chat",
    "title": "Chat with us",
    "subtitle": "We typically reply in a few minutes",
    "greeting": null,
    "teaser": null,
    "teaser_delay_seconds": 8
  }'::jsonb,

  -- Weekly schedule + timezone. Outside these hours the widget offers
  -- the offline form instead of live chat. NULL/absent = always open.
  business_hours    JSONB,

  ai_enabled        BOOLEAN NOT NULL DEFAULT false,
  -- Gated on plan tier in the UI; stored here so the bootstrap payload
  -- is a single read.
  show_branding     BOOLEAN NOT NULL DEFAULT true,
  locale            TEXT NOT NULL DEFAULT 'en',

  last_error        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE web_config IS
  'Per-account website chat widget. Mirrors whatsapp_config / instagram_config, but with no OAuth: there is no third party to authorise against, so "connected" means the snippet has been observed loading from an allowed origin.';
COMMENT ON COLUMN web_config.widget_key IS
  'PUBLIC. Embedded in the customer''s page source. Identifies the account to the bootstrap endpoint; grants nothing on its own — every conversation-touching endpoint additionally requires a signed visitor session token.';
COMMENT ON COLUMN web_config.widget_secret IS
  'SECRET, encrypted at rest. Signs visitor session tokens and verifies identity-verification HMACs. Never leaves the server; never appears in a bootstrap response.';
COMMENT ON COLUMN web_config.allowed_origins IS
  'Origins permitted to embed the widget. EMPTY DENIES EVERYTHING — unlike automations.channels where empty means "all". A default-open allowlist would make every new account an open relay for anonymous conversation creation.';
COMMENT ON COLUMN web_config.status IS
  'disconnected (never seen a live load) | connected | disabled (admin turned it off; bootstrap returns 403 without deleting config).';

CREATE INDEX IF NOT EXISTS idx_web_config_account
  ON web_config (account_id);

-- The bootstrap endpoint's routing read, on every widget load on every
-- customer page. Already served by the UNIQUE constraint on widget_key.

ALTER TABLE web_config ENABLE ROW LEVEL SECURITY;

-- Settings-class RLS, identical posture to instagram_config: any member
-- may read (the rail's status dot and the inbox composer both need to
-- know whether Web is live), admin+ may write. The public bootstrap and
-- session endpoints run on the service-role connection without an
-- auth.uid(), so these policies guard dashboard access only.
DROP POLICY IF EXISTS web_config_select ON web_config;
CREATE POLICY web_config_select ON web_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS web_config_insert ON web_config;
CREATE POLICY web_config_insert ON web_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS web_config_update ON web_config;
CREATE POLICY web_config_update ON web_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS web_config_delete ON web_config;
CREATE POLICY web_config_delete ON web_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));


-- ============================================================
-- 5) web_sessions — one visit, for attribution and analytics
-- ============================================================

CREATE TABLE IF NOT EXISTS web_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- The visitor's durable browser id. NOT a foreign key to contacts:
  -- a session is recorded from the first bootstrap call, which happens
  -- before the visitor has said anything and therefore before a contact
  -- row is worth creating.
  visitor_id      TEXT NOT NULL,

  -- Both SET NULL rather than CASCADE: deleting a contact or a thread
  -- should not silently rewrite traffic history.
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,

  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,

  -- Attribution captured at session start. This is the reason the table
  -- exists: "which landing page produced conversations that closed" is
  -- unanswerable from the messages table alone.
  page_url        TEXT,
  referrer        TEXT,
  utm             JSONB,

  user_agent      TEXT,
  -- HASHED, never the raw address. This is public internet traffic on
  -- someone else's website: we need it for abuse rate-limiting and
  -- coarse geo, and for nothing that justifies storing a PII-grade
  -- identifier. Hash is salted server-side (see web-session.service.ts).
  ip_hash         TEXT,
  country         TEXT,

  pages_viewed    INTEGER NOT NULL DEFAULT 1,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE web_sessions IS
  'One visitor session on a customer''s website. Analytics and attribution only — the conversation itself lives in the shared core. Safe to prune on a retention policy without losing any message history.';
COMMENT ON COLUMN web_sessions.ip_hash IS
  'Salted hash of the visitor IP, never the address itself. Used for abuse rate-limiting and coarse geo. Storing raw IPs of third parties browsing our customers'' sites would be a liability with no product justification.';
COMMENT ON COLUMN web_sessions.visitor_id IS
  'Deliberately not a FK to contacts.web_visitor_id: a session is recorded at first page load, before the visitor has sent anything and before a contact row exists.';

-- "Sessions for this account, newest first" — the Sessions dashboard.
CREATE INDEX IF NOT EXISTS idx_web_sessions_account_started
  ON web_sessions (account_id, started_at DESC);

-- Session resume on a repeat visit, and "every visit by this human".
CREATE INDEX IF NOT EXISTS idx_web_sessions_account_visitor
  ON web_sessions (account_id, visitor_id, started_at DESC);

-- Deep-link from a conversation in the inbox to the visit that produced
-- it (referrer, landing page, UTM).
CREATE INDEX IF NOT EXISTS idx_web_sessions_conversation
  ON web_sessions (conversation_id)
  WHERE conversation_id IS NOT NULL;

ALTER TABLE web_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS web_sessions_select ON web_sessions;
CREATE POLICY web_sessions_select ON web_sessions FOR SELECT
  USING (is_account_member(account_id));

-- Deliberately no client write policy: every insert and update comes
-- from the public endpoints on the server, using the service-role
-- connection. A browser-writable analytics table on a public surface
-- would be trivially poisonable.


-- ============================================================
-- 6) web-media bucket — visitor and agent attachments
-- ============================================================
--
-- Unlike instagram-media this is not a mirror of someone else's
-- expiring CDN — it is the origin store for files uploaded through the
-- widget composer and by agents replying from the inbox.
--
-- Public read with unguessable paths, matching flow-media and
-- instagram-media: objects are keyed
-- `<account_id>/<conversation_id>/<random>` — two 128-bit UUIDs plus
-- entropy, so enumeration is not feasible, and an <img src> works
-- without minting a signed URL on every render.
--
-- Writes are service-role only. The widget uploads by POSTing to the
-- API, which validates the visitor session token, the size and the MIME
-- type before writing. Letting the browser write directly would mean
-- handing an anonymous visitor a storage credential.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'web-media',
  'web-media',
  TRUE,
  20971520, -- 20 MB. Lower than instagram-media's 30 MB: this is an
            -- upload path open to anonymous visitors, so the cap is a
            -- cost and abuse control, not just a format limit.
  ARRAY[
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic',
    'video/mp4', 'video/quicktime', 'video/webm',
    'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm',
    'application/pdf',
    'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Web media is publicly readable" ON storage.objects;
CREATE POLICY "Web media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'web-media');

-- No INSERT / UPDATE / DELETE policies on purpose: every write goes
-- through the API's upload endpoint with the service-role key, which
-- bypasses RLS. A client-write policy here would be an anonymous
-- upload surface with no validation in front of it.
