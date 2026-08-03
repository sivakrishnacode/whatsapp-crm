-- ============================================================
-- 063_instagram_media_engagement.sql — give the Posts view enough
-- to be worth looking at.
--
-- THE PROBLEM
--   `instagram_media` stored only what was needed to caption a row in
--   the moderation queue: a thumbnail, a permalink, a caption. So the
--   Posts page could show a grid of pictures and nothing else — no
--   engagement, no way to tell a Reel from a carousel, no full-size
--   image, and no answer to "which post is actually doing anything".
--
--   `listMedia()` was already ASKING Meta for `comments_count` and
--   throwing the answer away, because there was no column to put it in.
--
-- WHAT EACH COLUMN IS FOR
--   media_url          The full-size asset. `thumbnail_url` is only
--                      populated for VIDEO; images carry their URL in
--                      media_url. Keeping both means the grid can use
--                      the small one and a detail view the large one,
--                      instead of collapsing them at sync time and
--                      losing the distinction forever.
--   like_count         Engagement, and the only ordering that answers
--                      "what worked".
--   comments_count     Instagram's total, which includes replies and
--                      comments made before we connected. Distinct from
--                      the local `open` count, which is moderation work
--                      outstanding — a post can show 40 comments and 0
--                      waiting.
--   is_comment_enabled Mirrors Meta's per-post comment switch, which
--                      the Posts page can now toggle. Nullable: unknown
--                      until the next sync, and "unknown" must not read
--                      as "disabled".
--   children           Carousel items (id/media_type/media_url). A
--                      CAROUSEL_ALBUM parent has NO media_url of its
--                      own, so without this a carousel is a blank tile.
--
-- All nullable, all backfilled by the next "Sync posts". Idempotent.
-- ============================================================

ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS media_url          TEXT;
ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS like_count         INTEGER;
ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS comments_count     INTEGER;
ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS is_comment_enabled BOOLEAN;
ALTER TABLE instagram_media ADD COLUMN IF NOT EXISTS children           JSONB;

COMMENT ON COLUMN instagram_media.media_url IS
  'Full-size asset. Images populate this and not thumbnail_url; videos populate both. NULL for CAROUSEL_ALBUM — use children.';

COMMENT ON COLUMN instagram_media.comments_count IS
  'Instagram''s own total, including replies and pre-connection comments. NOT the moderation backlog — that is COUNT(instagram_comments WHERE status = ''open'').';

COMMENT ON COLUMN instagram_media.is_comment_enabled IS
  'Meta''s per-post comment switch. NULL means not yet synced, which must not be rendered as "off".';

COMMENT ON COLUMN instagram_media.children IS
  'Carousel items as [{id, media_type, media_url, thumbnail_url}]. Only set for CAROUSEL_ALBUM.';

-- Caption search on the Posts page is an ILIKE over one account's posts
-- (capped at a few hundred rows), so a plain btree on the filter column
-- pair is enough — no trigram extension needed.
CREATE INDEX IF NOT EXISTS idx_instagram_media_account_type
  ON instagram_media (account_id, media_product_type);
