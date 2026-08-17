-- ============================================================
-- EXTEND NOTIFICATION TYPES
-- ============================================================
-- The notify_team automation step inserts notifications with type = 'automation',
-- but the CHECK constraint only allowed 'conversation_assigned'.
-- This migration extends the allowed types to support automation-generated notifications.

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'automation'));
