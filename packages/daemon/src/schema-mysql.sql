-- ework-daemon schema (MySQL 8.0+ / MariaDB 10.5+). Applied idempotently on boot:
-- CREATE TABLE IF NOT EXISTS + CREATE INDEX (no IF NOT EXISTS — MySQL lacks it;
-- re-runs tolerate ER_DUP_KEYNAME 1061). FK constraint names are {{tokenized}}
-- so prefixed instances don't collide on constraint-name uniqueness. Date
-- columns are VARCHAR(40) holding ISO-8601 strings — the app formats dates in
-- JS, never SQL date arithmetic, so strings avoid Date-vs-string friction
-- across drivers. FK columns carry their own indexes (MySQL requirement). All
-- tables InnoDB + utf8mb4 for FK CASCADE + full Unicode (emoji).

CREATE TABLE IF NOT EXISTS {{issues}} (
  id                  VARCHAR(36) PRIMARY KEY,
  tracker_type        VARCHAR(64)  NOT NULL,
  tracker_scope_key   VARCHAR(255) NOT NULL,
  tracker_scope       TEXT         NOT NULL,
  tracker_issue_id    VARCHAR(64)  NOT NULL,
  state               VARCHAR(16)  NOT NULL DEFAULT 'created',
  title               VARCHAR(512) NOT NULL DEFAULT '',
  created_at          VARCHAR(40)  NOT NULL,
  updated_at          VARCHAR(40)  NOT NULL,
  UNIQUE (tracker_type, tracker_scope_key, tracker_issue_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS {{op_sessions}} (
  id                  VARCHAR(36) PRIMARY KEY,
  issue_id            VARCHAR(36) NOT NULL,
  name                VARCHAR(64)  NOT NULL,
  state               VARCHAR(16)  NOT NULL DEFAULT 'idle',
  opencode_session_id VARCHAR(64),
  opencode_pid        BIGINT,
  workdir             VARCHAR(1024),
  created_at          VARCHAR(40)  NOT NULL,
  started_at          BIGINT,
  progress_comment_id VARCHAR(64),
  reaction_comment_id VARCHAR(64),
  current_prompt      TEXT,
  UNIQUE (issue_id, name),
  CONSTRAINT {{fk_sessions_issue}} FOREIGN KEY (issue_id) REFERENCES {{issues}}(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- UNIQUE(issue_id, name) above creates a composite index whose leftmost
-- prefix (issue_id) satisfies the FK's index requirement, so no separate
-- idx_sessions_issue is needed on MySQL.

CREATE TABLE IF NOT EXISTS {{messages}} (
  id                  VARCHAR(36) PRIMARY KEY,
  session_id          VARCHAR(36) NOT NULL,
  content             LONGTEXT    NOT NULL,
  source_comment_id   VARCHAR(64),
  reaction_comment_id VARCHAR(64),
  status              VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts            INT         NOT NULL DEFAULT 0,
  error               TEXT,
  created_at          VARCHAR(40) NOT NULL,
  updated_at          VARCHAR(40) NOT NULL,
  CONSTRAINT {{fk_messages_session}} FOREIGN KEY (session_id) REFERENCES {{op_sessions}}(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_messages_session ON {{messages}} (session_id);
CREATE INDEX idx_messages_status ON {{messages}} (status);

-- Multi-machine coordination (Phase 1). daemons register, heartbeat, and
-- lease issues via issues.owner_daemon_id. id is a DB-allocated logical slot
-- (not IP-bound) so a restarted daemon re-adopts an orphan id. Dates are
-- VARCHAR(40) ISO-8601 to match the rest of the schema. The issues.owner_daemon_id
-- column + op_sessions runtime-state columns + their indexes are added by
-- idempotent ALTER in db.ts initDB() so existing DBs upgrade in-place.
CREATE TABLE IF NOT EXISTS {{daemons}} (
  id                  BIGINT       PRIMARY KEY AUTO_INCREMENT,
  display_name        VARCHAR(255) NOT NULL DEFAULT '',
  internal_endpoint   VARCHAR(255) NOT NULL DEFAULT '',
  capacity            INT          NOT NULL DEFAULT 4,
  last_heartbeat      VARCHAR(40)  NOT NULL,
  registered_at       VARCHAR(40)  NOT NULL,
  status              VARCHAR(16)  NOT NULL DEFAULT 'active'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_daemons_heartbeat ON {{daemons}} (last_heartbeat);
