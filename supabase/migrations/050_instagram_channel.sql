-- ============================================================
-- 050_instagram_channel.sql — Instagram DM as a first-class channel
--
-- Turns the implicitly-WhatsApp core (contacts / conversations /
-- messages) into a multi-channel core, and adds the three Instagram-
-- specific tables.
--
-- WHY A SHARED CORE RATHER THAN instagram_* MIRRORS
--   The inbox, AI auto-reply, Automations, Flows and the public v1 API
--   all read conversations/messages. Forking the tables would mean
--   forking all five engines, which then drift. One `channel` column
--   costs this migration and nothing downstream.
--
-- THE phone NULLABILITY QUESTION
--   `contacts.phone` is NOT NULL today and backs a partial unique index
--   through the STORED generated column `phone_normalized`
--   (022_contact_phone_dedup.sql). Instagram users have an IGSID and no
--   phone, so `phone` has to become nullable.
--
--   That does NOT require touching the index. regexp_replace(NULL,...)
--   is NULL, and the index predicate `phone_normalized <> ''` evaluates
--   to NULL for those rows — SQL's three-valued logic excludes them.
--   Instagram-only contacts simply fall outside the phone uniqueness
--   domain. No backfill, no reindex, no rewrite.
--
--   A CHECK constraint replaces the lost NOT NULL: every contact must
--   carry at least one identity (phone or IGSID). Without it a bug
--   could insert an identity-less row that no channel can ever reach.
--
-- IDENTITY IS NOT MERGED ACROSS CHANNELS
--   An IGSID carries no phone number, so there is no reliable way to
--   tell that @someuser is the same human as +91xxxxxxxxxx. The same
--   person messaging on both channels becomes two contacts. That is the
--   honest representation; a deliberate merge feature can collapse them
--   later. Guessing here would silently cross-link strangers' data
--   between tenants' customers.
--
-- Idempotent — safe to re-run.
-- ============================================================


-- ============================================================
-- 1) conversations — the channel discriminator
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel         TEXT NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

-- Text + CHECK rather than a PG enum, matching how `status` is modelled
-- on this table. Adding a channel later is then an ALTER of one
-- constraint instead of an enum migration with a table lock.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_chk;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_chk
  CHECK (channel IN ('whatsapp', 'instagram'));

COMMENT ON COLUMN conversations.channel IS
  'Which platform this thread lives on. Every existing row is whatsapp — the column was added when Instagram landed.';
COMMENT ON COLUMN conversations.last_inbound_at IS
  'Timestamp of the most recent customer-sent message. Drives Instagram''s 24-hour messaging window (see ig-window.util.ts). Maintained by the webhook ingest paths, backfilled below for pre-existing rows.';

-- Backfill from history so the 24h window is correct for threads that
-- existed before this column did. Only touches rows where it is unset,
-- so a re-run is a no-op rather than a full rewrite.
UPDATE conversations c
SET last_inbound_at = m.max_created
FROM (
  SELECT conversation_id, MAX(created_at) AS max_created
  FROM messages
  WHERE sender_type = 'customer'
  GROUP BY conversation_id
) m
WHERE m.conversation_id = c.id
  AND c.last_inbound_at IS NULL;

-- The inbox lists "threads for this account, optionally filtered to one
-- channel, newest first". Without channel in the index that filter is a
-- post-scan filter on the account's entire thread history.
CREATE INDEX IF NOT EXISTS idx_conversations_account_channel_time
  ON conversations (account_id, channel, last_message_at DESC);

-- findOrCreateConversation looks a thread up by (account, contact,
-- channel). One contact can now legitimately own two threads, so this
-- must be a three-column lookup — see the note in
-- whatsapp-webhook.service.ts.
CREATE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations (account_id, contact_id, channel);


-- ============================================================
-- 2) contacts — Instagram identity, optional phone
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ig_scoped_id TEXT,
  ADD COLUMN IF NOT EXISTS ig_username  TEXT;

ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_identity_chk;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_identity_chk
  CHECK (phone IS NOT NULL OR ig_scoped_id IS NOT NULL);

COMMENT ON COLUMN contacts.ig_scoped_id IS
  'Instagram-scoped user ID (IGSID). App-scoped: the SAME Instagram user has a different IGSID under a different Meta app, so these values do not survive an app migration.';
COMMENT ON COLUMN contacts.ig_username IS
  'Instagram @handle, cached from the User Profile API. Display only — usernames are mutable and must never be used as a key.';
COMMENT ON COLUMN contacts.phone IS
  'E.164-ish phone. NULL for Instagram-only contacts. The partial unique index on phone_normalized excludes NULLs automatically.';

-- Instagram's equivalent of the phone uniqueness rule. Partial, because
-- the vast majority of rows are WhatsApp-only and carry NULL here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_igsid
  ON contacts (account_id, ig_scoped_id)
  WHERE ig_scoped_id IS NOT NULL;


-- ============================================================
-- 3) messages — soft delete + a per-channel extras bag
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata   JSONB;

COMMENT ON COLUMN messages.deleted_at IS
  'Tombstone. Instagram sends message deletions as a webhook (message.is_deleted); the row is kept so reply chains and reactions pointing at it stay resolvable, and the UI renders "message deleted".';
COMMENT ON COLUMN messages.metadata IS
  'Channel-specific extras that do not deserve a column: Instagram story-reply context, quick-reply payloads, attachment kinds, edit history. NULL for the overwhelming majority of rows — deliberately no DEFAULT so adding it did not rewrite the table.';

-- Rendering a thread must not have to read tombstones out of the heap.
CREATE INDEX IF NOT EXISTS idx_messages_conv_live
  ON messages (conversation_id, created_at DESC)
  WHERE deleted_at IS NULL;


-- ============================================================
-- 4) instagram_config — one Instagram connection per account
-- ============================================================

CREATE TABLE IF NOT EXISTS instagram_config (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Meta identifiers. ig_user_id is globally unique because the inbound
  -- webhook has nothing else to route on: entry[].id IS this value, and
  -- two accounts claiming one Instagram profile would make routing
  -- ambiguous. The WhatsApp side learned this the hard way — its
  -- webhook has to defensively handle duplicate phone_number_id rows.
  ig_user_id         TEXT NOT NULL UNIQUE,

  -- The SAME Instagram account reports two ids:
  --   GET /me?fields=user_id  → 17841445515874274  (professional account id)
  --   the envelope's own `id` → 28011694518467843  (app-scoped id)
  -- Which of the two lands in a webhook's entry[].id varies by event
  -- type and Graph version. Storing both and matching on either is the
  -- difference between routing working and inbound messages vanishing
  -- with only a "no config for ig_user_id" line in the log.
  ig_app_scoped_id   TEXT,

  ig_username        TEXT,
  profile_picture_url TEXT,

  -- AES-256-GCM at rest, same encrypt()/decrypt() as
  -- whatsapp_config.access_token and ai_configs.api_key.
  access_token       TEXT NOT NULL,
  token_expires_at   TIMESTAMPTZ,
  token_refreshed_at TIMESTAMPTZ,

  status             TEXT NOT NULL DEFAULT 'disconnected'
                       CHECK (status IN ('disconnected', 'connected', 'token_expired', 'error')),
  subscribed_fields  TEXT[] NOT NULL DEFAULT '{}',
  subscribed_at      TIMESTAMPTZ,
  connected_at       TIMESTAMPTZ,
  last_error         TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE instagram_config IS
  'Per-account Instagram Login connection. Mirrors whatsapp_config. One Instagram professional account per CRM account.';
COMMENT ON COLUMN instagram_config.token_expires_at IS
  'Instagram long-lived tokens last 60 days and MUST be refreshed before expiry — there is no silent renewal. The daily refresh sweep reads this; if it stops running the integration dies exactly 60 days later.';
COMMENT ON COLUMN instagram_config.status IS
  'disconnected | connected | token_expired | error. token_expired is distinct from error because it has a specific remedy (reconnect) that the UI surfaces differently.';

-- Re-runnability for databases that took an earlier draft of this file.
ALTER TABLE instagram_config
  ADD COLUMN IF NOT EXISTS ig_app_scoped_id TEXT;

CREATE INDEX IF NOT EXISTS idx_instagram_config_account
  ON instagram_config (account_id);

-- Webhook routing reads this on every inbound event.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_config_app_scoped_id
  ON instagram_config (ig_app_scoped_id)
  WHERE ig_app_scoped_id IS NOT NULL;

-- Drives the refresh sweep's "expiring soon" scan.
CREATE INDEX IF NOT EXISTS idx_instagram_config_token_expires
  ON instagram_config (token_expires_at)
  WHERE token_expires_at IS NOT NULL;

ALTER TABLE instagram_config ENABLE ROW LEVEL SECURITY;

-- Settings-class RLS, mirroring ai_configs: any member may read (the
-- rail's status dot and the inbox composer both need to know whether
-- Instagram is live), admin+ may write. The webhook and the refresh job
-- run without an auth.uid() on the service-role connection, so these
-- policies guard dashboard reads, not the engine.
DROP POLICY IF EXISTS instagram_config_select ON instagram_config;
CREATE POLICY instagram_config_select ON instagram_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS instagram_config_insert ON instagram_config;
CREATE POLICY instagram_config_insert ON instagram_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS instagram_config_update ON instagram_config;
CREATE POLICY instagram_config_update ON instagram_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS instagram_config_delete ON instagram_config;
CREATE POLICY instagram_config_delete ON instagram_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));


-- ============================================================
-- 5) instagram_media — thin cache of the account's own posts
-- ============================================================

CREATE TABLE IF NOT EXISTS instagram_media (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ig_media_id        TEXT NOT NULL,
  media_type         TEXT,
  media_product_type TEXT,
  permalink          TEXT,
  thumbnail_url      TEXT,
  caption            TEXT,
  posted_at          TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, ig_media_id)
);

COMMENT ON TABLE instagram_media IS
  'Cache, not a source of truth. Exists so the Comments view can show which post a comment belongs to without an API round trip per row. Safe to truncate and re-sync.';

CREATE INDEX IF NOT EXISTS idx_instagram_media_account_posted
  ON instagram_media (account_id, posted_at DESC);

ALTER TABLE instagram_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instagram_media_select ON instagram_media;
CREATE POLICY instagram_media_select ON instagram_media FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS instagram_media_write ON instagram_media;
CREATE POLICY instagram_media_write ON instagram_media FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));


-- ============================================================
-- 6) instagram_comments — comment moderation queue
-- ============================================================

CREATE TABLE IF NOT EXISTS instagram_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  ig_comment_id     TEXT NOT NULL,
  ig_media_id       TEXT NOT NULL,
  parent_comment_id TEXT,

  from_igsid        TEXT,
  from_username     TEXT,
  -- Set when the commenter is already a known contact, or once they DM
  -- us. SET NULL rather than CASCADE: deleting a contact should not
  -- erase the moderation history of a public comment.
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,

  text              TEXT,
  is_from_business  BOOLEAN NOT NULL DEFAULT false,

  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'replied', 'hidden', 'deleted')),
  replied_at        TIMESTAMPTZ,

  -- A private reply opens a real DM thread; linking it means the
  -- comment card can deep-link into the inbox.
  private_reply_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  private_replied_at TIMESTAMPTZ,

  commented_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Idempotency for the comments webhook, which Meta may redeliver.
  UNIQUE (account_id, ig_comment_id)
);

COMMENT ON COLUMN instagram_comments.is_from_business IS
  'True for the account''s own comments, which arrive on the same webhook as customer ones. The moderation queue filters these out — replying to yourself is not a task.';
COMMENT ON COLUMN instagram_comments.private_replied_at IS
  'Meta allows exactly ONE private reply per comment, within 7 days. This timestamp is what stops a second attempt from being made and failing at the API.';

CREATE INDEX IF NOT EXISTS idx_instagram_comments_account_status
  ON instagram_comments (account_id, status, commented_at DESC);

CREATE INDEX IF NOT EXISTS idx_instagram_comments_media
  ON instagram_comments (account_id, ig_media_id);

ALTER TABLE instagram_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instagram_comments_select ON instagram_comments;
CREATE POLICY instagram_comments_select ON instagram_comments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS instagram_comments_write ON instagram_comments;
CREATE POLICY instagram_comments_write ON instagram_comments FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));


-- ============================================================
-- 7) updated_at triggers
-- ============================================================

DROP TRIGGER IF EXISTS set_updated_at ON instagram_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON instagram_comments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
