-- ============================================================
-- 062_message_content_types.sql — let the inbox hold every kind of
-- message WhatsApp can deliver.
--
-- THE PROBLEM
--   `messages_content_type_check` allowed 8 values. The webhook parser
--   mirrors that list in ALLOWED_CONTENT_TYPES and coerces anything
--   else to 'text', so every message type outside the 8 arrived as a
--   text row reading "[Unsupported message type: <type>]".
--
--   That is what a customer tapping a template's quick-reply button
--   looked like in the inbox: Meta sends `type: "button"`, the parser
--   had no case for it, and the agent saw
--   "[Unsupported message type: button]" instead of the words the
--   customer actually tapped ("Stop promotions"). An opt-out request
--   rendered as a parser error.
--
-- WHY WIDEN THE CHECK RATHER THAN DROP IT
--   The constraint is doing real work — it is what stops a typo'd
--   content_type reaching the renderer, which has no case for it and
--   would fall through to a bare text paragraph. Widening keeps that
--   guarantee while making room for the types that were being
--   flattened.
--
-- THE ONE TYPE DELIBERATELY NOT ADDED: 'button'
--   A tap on a template's quick-reply button and a tap on an
--   interactive message's button are the same event to an agent, and
--   the same event to the Flows engine, which routes on
--   `interactive_reply_id`. They arrive under different Meta type
--   names purely because of how the message was originally sent, so
--   both are stored as 'interactive' and the origin is recorded in
--   `metadata.source`. A separate content_type would have split one
--   concept across two renderers and two routing branches.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_type_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    -- Existing eight.
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',   -- also covers a template quick-reply tap; see above

    -- Added by this migration. Each has its own renderer in
    -- apps/web/src/components/inbox/message-bubble.tsx — adding a value
    -- here without one puts the message back in the bare-paragraph
    -- fallback this migration exists to eliminate.
    'sticker',       -- was flattened to 'image', which framed it in a bubble
    'contacts',      -- shared contact card(s)
    'order',         -- cart submitted from the catalog
    'system',        -- customer changed their number / platform notice
    'unsupported'    -- WhatsApp itself could not forward the content
  ));

COMMENT ON COLUMN messages.content_type IS
  'How to render this message. Guarded by messages_content_type_check; every value needs a case in MessageContent (apps/web/src/components/inbox/message-bubble.tsx) and a producer in the webhook parser. A template quick-reply tap is stored as ''interactive'', not ''button'' — see migration 062.';

COMMENT ON COLUMN messages.metadata IS
  'Channel-specific extras that do not deserve a column. Instagram: story/reel context, attachment kind. WhatsApp: `template` (the header media, footer and buttons as sent, so the bubble can show what the customer saw), `order` items, `contacts` cards, `location` coordinates, `source` for a quick-reply tap''s origin. NULL on most rows.';
