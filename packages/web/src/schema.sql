-- ework schema. Applied idempotently on boot (IF NOT EXISTS everywhere).
-- See db.ts for PRAGMA setup (WAL + foreign_keys = ON).

-- login stays PRIMARY KEY intentionally. Renaming users is not supported;
-- swap to INTEGER user_id + UNIQUE(login) if that ever changes.
CREATE TABLE IF NOT EXISTS users (
  login         TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'human'
                CHECK (kind IN ('human','bot','system')),
  display_name  TEXT,
  password_hash TEXT,
  email         TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- JSON array of upstream Git URLs (any platform: Gitea, GitHub, GitLab, ...).
  -- First entry is the default; daemon reads it via webhook payload's
  -- repository.clone_url so it knows where AI should `git clone` from.
  -- Empty array = no upstream bound (project is purely a tracker).
  upstream_urls TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (owner, name)
);

CREATE TABLE IF NOT EXISTS issues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'open'
             CHECK (state IN ('open','closed')),
  author     TEXT NOT NULL REFERENCES users(login),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- NULL when open; stamped on close, cleared on reopen. Backfill-safe because
  -- migrateIssuesTable ADDs the column idempotently for legacy DBs.
  closed_at  TEXT,
  UNIQUE (project_id, number)
);
CREATE INDEX IF NOT EXISTS issues_project_state_updated
  ON issues (project_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS issues_state_updated
  ON issues (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author     TEXT NOT NULL REFERENCES users(login),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS comments_issue_created
  ON comments (issue_id, created_at);

CREATE TABLE IF NOT EXISTS labels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#888888',
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id  INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id  INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);

CREATE TABLE IF NOT EXISTS reactions (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_login TEXT NOT NULL REFERENCES users(login),
  content    TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_login, content)
);
CREATE INDEX IF NOT EXISTS reactions_comment
  ON reactions (comment_id);

CREATE TABLE IF NOT EXISTS attachments (
  uuid        TEXT PRIMARY KEY,
  issue_id    INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INTEGER NOT NULL,
  blob_path   TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(login),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_issue
  ON attachments (issue_id);

-- Webhooks (Gitea-compatible). Scoped per-project so different repos can fan out
-- to different downstream consumers. `events` is a JSON array of event types
-- ('issues', 'issue_comment', 'push', ...). ework v1 emits only the first two.
CREATE TABLE IF NOT EXISTS webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/json',
  -- JSON array of event names: e.g. '["issues","issue_comment"]'.
  events      TEXT NOT NULL DEFAULT '["issues","issue_comment"]',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_project
  ON webhooks (project_id);

-- Delivery history. One row per attempt. Retries append new rows (don't overwrite),
-- so a failed webhook shows the full retry trail.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id    INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  delivery_uuid TEXT NOT NULL,
  payload       TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  duration_ms   INTEGER,
  error         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_webhook
  ON webhook_deliveries (webhook_id);
CREATE INDEX IF NOT EXISTS deliveries_created
  ON webhook_deliveries (created_at DESC);

-- Personal Access Tokens (Gitea-aligned). Hashed with per-token salt so the
-- DB leak doesn't reveal tokens; last_eight enables indexed lookup without
-- storing the plaintext. `scopes` is stored but not yet enforced — every PAT
-- inherits the user's full perms in v1; granularity lands with project_members.
CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_login       TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  salt             TEXT NOT NULL,
  token_hash       TEXT NOT NULL,
  token_last_eight TEXT NOT NULL,
  scopes           TEXT NOT NULL DEFAULT '[]',
  -- JSON array of CIDR strings (IPv4). Empty = no restriction. Validated in
  -- store.ts createPat; verifyPat checks the request IP against this list.
  ip_allowlist     TEXT NOT NULL DEFAULT '[]',
  expires_at       TEXT,
  last_used_at     TEXT,
  created_at       TEXT NOT NULL,
  revoked_at       TEXT
);
CREATE INDEX IF NOT EXISTS pat_user
  ON personal_access_tokens (user_login);
CREATE INDEX IF NOT EXISTS pat_last_eight
  ON personal_access_tokens (token_last_eight);

-- Per-project RBAC. Roles follow Gitea semantics:
--   reader: can read issues + comments (currently no-op since all authed users
--           can read; reserved for future private projects)
--   writer: + create issues, comment, close/reopen, upload attachments, react
--   admin:  + manage project webhooks + manage project members
-- Site-admins (users.is_admin=1) bypass all checks. PAT scope enforcement also
-- routes through here: a write-scoped PAT can only write where the owning user
-- has writer+ role on the target project.
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'writer'
             CHECK (role IN ('reader','writer','admin')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_login)
);
CREATE INDEX IF NOT EXISTS project_members_user
  ON project_members (user_login);
