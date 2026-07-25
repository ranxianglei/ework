-- ework-daemon schema (SQLite). Applied idempotently on boot via
-- CREATE TABLE/INDEX IF NOT EXISTS. See db.ts for PRAGMA setup
-- (WAL + foreign_keys = ON). {{tokenized}} names so WORK_DB_PREFIX can
-- share one DB across multiple daemon instances.

CREATE TABLE IF NOT EXISTS {{issues}} (
  id TEXT PRIMARY KEY,
  tracker_type TEXT NOT NULL,
  tracker_scope_key TEXT NOT NULL,
  tracker_scope TEXT NOT NULL,
  tracker_issue_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'created',
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tracker_type, tracker_scope_key, tracker_issue_id)
);

CREATE TABLE IF NOT EXISTS {{op_sessions}} (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES {{issues}}(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  opencode_session_id TEXT,
  opencode_pid INTEGER,
  workdir TEXT,
  created_at TEXT NOT NULL,
  started_at INTEGER,
  progress_comment_id TEXT,
  reaction_comment_id TEXT,
  current_prompt TEXT,
  UNIQUE(issue_id, name)
);

CREATE TABLE IF NOT EXISTS {{messages}} (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES {{op_sessions}}(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source_comment_id TEXT,
  reaction_comment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_issue ON {{op_sessions}}(issue_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON {{messages}}(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON {{messages}}(status);
