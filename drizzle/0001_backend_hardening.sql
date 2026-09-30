-- Additive only: production already holds data.
-- Admin rights of a session expire after an idle period; the server keeps the time of the
-- last admin activity here. NULL (all sessions created before this migration) = not active.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS admin_seen BIGINT;
