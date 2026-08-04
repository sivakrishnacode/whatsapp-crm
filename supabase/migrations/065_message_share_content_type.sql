-- ============================================================
-- 065_message_share_content_type.sql — a shared post or reel is a
-- reference, not an attachment.
--
-- THE BUG THIS FIXES
--   A shared Instagram reel arrived as content_type 'video' and the
--   inbox dutifully rendered a <video> element. But Meta sends NO url
--   for a reel share — only a title and a reel_video_id — so media_url
--   was NULL and every one of them painted as empty player chrome:
--   controls, no picture, no error, forever.
--
-- THE COST THIS FIXES
--   Shared posts (`ig_post`) and anything Meta invented since we last
--   looked fell through mapAttachment's `default` branch to
--   kind:'file', which meant the mirror service copied up to 30 MB of
--   somebody else's video into our storage — and then the renderer
--   showed it as plain text, because content_type was 'text'. Bytes
--   paid for, never displayed.
--
-- WHY A NEW CONTENT TYPE RATHER THAN REUSING 'text'
--   Per migration 062: every content_type needs a renderer and a
--   producer. 'text' has a renderer that shows a paragraph, which is
--   exactly the bare fallback 062 existed to eliminate. A share has a
--   shape of its own — a title, a kind, and no bytes — and saying so
--   is what lets the inbox draw a card instead of guessing.
--
-- WHAT A 'share' ROW LOOKS LIKE
--   media_url  NULL, always. That is the point: we store no copy.
--   metadata   { ig_attachment_type: 'ig_reel' | 'ig_post' | 'share',
--                title?: string, reel_video_id?: string }
-- ============================================================

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_type_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
    'sticker',
    'contacts',
    'order',
    'system',
    'unsupported',

    -- Added by this migration. Renderer: the `share` case in
    -- MessageContent (apps/web/src/components/inbox/message-bubble.tsx).
    -- Producer: mapAttachment (instagram-webhook.service.ts).
    'share'          -- someone forwarded a post or reel; we keep no copy
  ));

COMMENT ON COLUMN messages.content_type IS
  'How to render this message. Guarded by messages_content_type_check; every value needs a case in MessageContent (apps/web/src/components/inbox/message-bubble.tsx) and a producer in the webhook parser. ''share'' means a forwarded Instagram post or reel: media_url is always NULL because the content belongs to Instagram and is referenced, never copied.';
