-- MAX chat-bot state (bot/**). Idempotent: safe to re-run.
-- The bot only reads the app tables (records, progress, sessions) and owns these two tables.

-- One row per MAX user who has interacted with the bot.
-- user_id is the MAX user id as text (int64 without precision loss);
-- the same user appears in the app as progress.user_id = 'max:' || user_id.
-- Timestamps are Unix milliseconds, like the rest of the schema.
CREATE TABLE IF NOT EXISTS bot_users (
  user_id TEXT PRIMARY KEY CHECK (user_id ~ '^[0-9]{1,20}$'),
  first_name TEXT,
  started_at BIGINT,
  -- Set on bot_stopped / bot_removed / dialog_removed or a 403 from the API.
  -- While it is set the bot never writes to the user on its own initiative.
  stopped_at BIGINT,
  -- Explicit opt-in to olympiad reminders (button or /reminders). Reset on stop.
  reminders_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS bot_users_reminders
  ON bot_users(user_id)
  WHERE reminders_enabled AND stopped_at IS NULL;

-- At most one reminder of each kind per user and olympiad:
-- the row is claimed before sending and kept after a successful send.
CREATE TABLE IF NOT EXISTS bot_reminders (
  user_id TEXT NOT NULL REFERENCES bot_users(user_id) ON DELETE CASCADE,
  olympiad_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('d3', 'd1')),
  sent_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, olympiad_id, kind)
);
