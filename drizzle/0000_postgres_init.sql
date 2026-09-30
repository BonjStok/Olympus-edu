CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  draft TEXT,
  updated BIGINT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);
CREATE INDEX IF NOT EXISTS records_kind ON records(kind);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_record ON revisions(record_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT,
  photo TEXT,
  admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0, 1)),
  expires BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);

CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated BIGINT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS progress_updated ON progress(updated);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL
);
